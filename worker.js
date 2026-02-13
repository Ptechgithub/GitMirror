const CACHE_TTL = 31536000; // 1 year
const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Range",
};
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        // Handle OPTIONS (CORS preflight)
        if (request.method === "OPTIONS") {
            return new Response(null, {
                headers: CORS_HEADERS
            });
        }
        // 1. UI RENDER
        if (url.pathname === "/") {
            return new Response(renderUI(url.origin), {
                headers: {
                    "content-type": "text/html; charset=UTF-8",
                    "x-content-type-options": "nosniff",
                    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
                },
            });
        }
        // 2. SHORT LINK PROXY (/d/<code>)
        if (url.pathname.startsWith("/d/")) {
            const code = url.pathname.slice(3);
            const target = await env.SHORT_KV.get("c:" + code);
            if (!target) return new Response(render404(), {
                status: 404,
                headers: {
                    "content-type": "text/html; charset=UTF-8"
                }
            });
            return proxyFetch(target, request, ctx);
        }
        // 3. API: CREATE SHORT LINK
        if (url.pathname === "/api/shorten" && request.method === "POST") {
            try {
                const payload = await request.json();
                const original = payload?.url;
                if (!original) return json({
                    error: "URL is required"
                }, 400);
                const target = normalize(original);
                const hash = await sha1(target);
                let code = await env.SHORT_KV.get("u:" + hash);
                if (!code) {
                    let retries = 0;
                    do {
                        code = makeShortCode(6);
                        retries++;
                    } while ((await env.SHORT_KV.get("c:" + code)) && retries < 5);
                    await env.SHORT_KV.put("c:" + code, target);
                    await env.SHORT_KV.put("u:" + hash, code);
                }
                return json({
                    short: `d/${code}`,
                    long: target,
                    code
                });
            } catch (e) {
                return json({
                    error: e.message
                }, 400);
            }
        }
        // 4. API: GET META
        if (url.pathname === "/api/meta") {
            const raw = url.searchParams.get("url");
            if (!raw) return json({
                error: "URL missing"
            }, 400);
            try {
                const target = normalize(raw);
                let res = await fetchWithTimeout(target, {
                    method: "HEAD",
                    redirect: "follow"
                });
                if (!res.ok || !res.headers.get("content-length")) {
                    res = await fetchWithTimeout(target, {
                        method: "GET",
                        headers: {
                            Range: "bytes=0-0"
                        },
                        redirect: "follow"
                    });
                }
                if (!res || !res.ok) throw new Error("File not reachable");
                return json({
                    name: getFilename(target, res),
                    size: Number(res.headers.get("content-length")) || 0,
                    type: detectType(target),
                    ok: true
                });
            } catch (e) {
                return json({
                    error: "Failed to fetch metadata",
                    details: e.message
                }, 400);
            }
        }
        // 5. PROXY HANDLER (Main Download Logic)
        const rawPath = url.pathname.slice(1);
        if (!rawPath) return new Response("Bad Request", {
            status: 400
        });
        let target;
        try {
            if (rawPath.startsWith("https") || rawPath.startsWith("http")) target = normalize(rawPath);
            else if (rawPath.startsWith("github.com") || rawPath.startsWith("raw.githubusercontent.com")) target = normalize("https://" + rawPath);
            else target = normalize(rawPath);
        } catch {
            return new Response("Invalid URL format", {
                status: 400
            });
        }
        return proxyFetch(target, request, ctx);
    },
};
/* ================= HELPER FUNCTIONS ================= */
async function proxyFetch(target, request, ctx) {
    const isRange = request.headers.has("Range");
    const cache = caches.default;
    const cacheKey = new Request(target, {
        method: "GET"
    });
    // Serve from cache if available
    if (!isRange && request.method === "GET") {
        const cached = await cache.match(cacheKey);
        if (cached) {
            const h = new Headers(cached.headers);
            h.set("X-Cache-Status", "HIT");
            h.set("X-Powered-By", "GitMirror-Pro");
            Object.keys(CORS_HEADERS).forEach(k => h.set(k, CORS_HEADERS[k]));
            return new Response(cached.body, {
                status: cached.status,
                headers: h
            });
        }
    }
    const upstreamHeaders = new Headers();
    const headersToKeep = ["range", "user-agent", "accept", "accept-encoding"];
    for (const [k, v] of request.headers) {
        if (headersToKeep.includes(k.toLowerCase())) upstreamHeaders.set(k, v);
    }
    upstreamHeaders.set("User-Agent", "Mozilla/5.0 (GitMirror)");
    try {
        const upstreamRes = await fetch(target, {
            method: request.method,
            headers: upstreamHeaders,
            redirect: "follow"
        });
        const responseHeaders = new Headers(upstreamRes.headers);
        // Cleanup
        responseHeaders.delete("link");
        responseHeaders.delete("strict-transport-security");
        Object.keys(CORS_HEADERS).forEach(k => responseHeaders.set(k, CORS_HEADERS[k]));
        responseHeaders.set("X-Cache-Status", isRange ? "BYPASS" : "MISS");
        responseHeaders.set("X-Powered-By", "GitMirror-Pro");
        const filename = getFilename(target, upstreamRes);
        responseHeaders.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
        if (upstreamRes.status === 200 && !isRange && request.method === "GET") {
            responseHeaders.set("Cache-Control", `public, max-age=${CACHE_TTL}, immutable`);
        } else {
            responseHeaders.set("Cache-Control", "no-store");
        }
        const response = new Response(upstreamRes.body, {
            status: upstreamRes.status,
            headers: responseHeaders
        });
        if (upstreamRes.status === 200 && !isRange && request.method === "GET") {
            ctx.waitUntil(cache.put(cacheKey, response.clone()));
        }
        return response;
    } catch (err) {
        return new Response("Upstream Error: " + err.message, {
            status: 502
        });
    }
}

function normalize(raw) {
    let urlStr = String(raw || "").trim();
    if (!/^https?:\/\//i.test(urlStr)) urlStr = "https://" + urlStr;
    const u = new URL(urlStr);
    const allowed = ["github.com", "raw.githubusercontent.com", "objects.githubusercontent.com", "releases.githubusercontent.com", "gist.githubusercontent.com"];
    if (!allowed.includes(u.hostname)) throw new Error("Host not allowed");
    return u.href;
}

function getFilename(url, res) {
    const u = new URL(url);
    let name = u.pathname.split("/").pop();
    if (res && res.headers) {
        const cd = res.headers.get("content-disposition");
        if (cd) {
            const mStar = cd.match(/filename\*\s*=\s*([^;]+)/i);
            if (mStar) {
                const parts = mStar[1].trim().replace(/(^['"]|['"]$)/g, "").split("''");
                return decodeURIComponent(parts.length === 2 ? parts[1] : parts[0]);
            }
            const m = cd.match(/filename\s*=\s*("?)([^";]+)\1/i);
            if (m) return m[2];
        }
    }
    return name || "downloaded-file";
}

function detectType(url) {
    if (/\/releases\//.test(url)) return "Release";
    if (/\/archive\//.test(url)) return "Source Code";
    if (/raw\.github/.test(url)) return "Raw File";
    const ext = url.split('.').pop().toLowerCase();
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return "Archive";
    if (['exe', 'msi', 'apk', 'dmg', 'iso'].includes(ext)) return "Binary";
    return "File";
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            ...CORS_HEADERS,
            "content-type": "application/json"
        }
    });
}

function makeShortCode(len) {
    const chars = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ123456789";
    let s = "";
    for (let i = 0; i < len; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
    return s;
}
async function sha1(str) {
    const buf = new TextEncoder().encode(str);
    const hash = await crypto.subtle.digest("SHA-1", buf);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}
async function fetchWithTimeout(url, options = {}, timeout = 5000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    const response = await fetch(url, {
        ...options,
        signal: controller.signal
    });
    clearTimeout(id);
    return response;
}

function render404() {
    return `<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><title>404</title><style>body{background:#0f172a;color:white;display:flex;height:100vh;align-items:center;justify-content:center;font-family:sans-serif;flex-direction:column}h1{font-size:4rem;margin:0;color:#ef4444}a{color:#8b5cf6;margin-top:20px;text-decoration:none}</style></head><body><h1>404</h1><p>لینک مورد نظر پیدا نشد.</p><a href="/">بازگشت به خانه</a></body></html>`;
}
/* ================= PROFESSIONAL UI ================= */
function renderUI(origin) {
    return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>گیت میرور | دانلود پرسرعت از گیت‌هاب</title>
    <meta name="description" content="دانلود فایل‌های GitHub با سرعت بالا و لینک مستقیم، بدون محدودیت و تحریم.">
    <meta name="theme-color" content="#1e293b">
    <link href="https://cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.003/Vazirmatn-font-face.css" rel="stylesheet" type="text/css" />
    <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
    <style>
        :root {
            --bg-body: #0f172a;
            --bg-card: #1e293b;
            --bg-input: #334155;
            --primary: #8b5cf6;
            --primary-hover: #7c3aed;
            --text-main: #f1f5f9;
            --text-muted: #94a3b8;
            --border: #334155;
            --success: #10b981;
            --error: #ef4444;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; outline: none; }
        
        body {
            font-family: 'Vazirmatn', sans-serif;
            background-color: var(--bg-body);
            background-image: radial-gradient(at 0% 0%, rgba(139, 92, 246, 0.15) 0px, transparent 50%), 
                              radial-gradient(at 100% 100%, rgba(16, 185, 129, 0.1) 0px, transparent 50%);
            color: var(--text-main);
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            padding: 20px;
        }

        .container {
            width: 100%;
            max-width: 550px;
            animation: fadeIn 0.6s ease-out;
        }

        .card {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 24px;
            padding: 32px;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
            position: relative;
            overflow: hidden;
        }
        
        .header { text-align: center; margin-bottom: 30px; }
        .logo { 
            font-size: 40px; 
            margin-bottom: 10px; 
            background: linear-gradient(135deg, #a78bfa, #2dd4bf); 
            -webkit-background-clip: text; 
            -webkit-text-fill-color: transparent; 
            font-weight: 800;
            letter-spacing: -1px;
        }
        .desc { color: var(--text-muted); font-size: 14px; }

        .input-group { position: relative; margin-bottom: 24px; }
        .input-wrapper {
            position: relative;
            display: flex;
            align-items: center;
        }
        .input-icon {
            position: absolute;
            right: 16px;
            color: var(--text-muted);
            width: 20px;
            height: 20px;
        }
        input {
            width: 100%;
            background: var(--bg-input);
            border: 2px solid transparent;
            border-radius: 16px;
            padding: 16px 50px 16px 16px;
            color: white;
            font-family: inherit;
            font-size: 15px;
            transition: all 0.3s;
        }
        input:focus {
            border-color: var(--primary);
            box-shadow: 0 0 0 4px rgba(139, 92, 246, 0.1);
        }
        
        .btn {
            width: 100%;
            padding: 16px;
            border: none;
            border-radius: 16px;
            font-family: inherit;
            font-weight: 700;
            font-size: 16px;
            cursor: pointer;
            transition: all 0.2s;
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 10px;
        }
        .btn-primary {
            background: linear-gradient(135deg, var(--primary), var(--primary-hover));
            color: white;
            box-shadow: 0 10px 15px -3px rgba(139, 92, 246, 0.3);
        }
        .btn-primary:hover { transform: translateY(-2px); box-shadow: 0 15px 20px -3px rgba(139, 92, 246, 0.4); }
        .btn-primary:disabled { opacity: 0.7; cursor: not-allowed; transform: none; }

        /* Results Area */
        .result-card {
            background: rgba(15, 23, 42, 0.6);
            border-radius: 16px;
            padding: 20px;
            margin-top: 24px;
            border: 1px solid var(--border);
            display: none;
            animation: slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .result-card.active { display: block; }
        
        .file-info {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 15px;
            border-bottom: 1px solid var(--border);
        }
        .file-name { font-weight: bold; font-size: 15px; color: #e2e8f0; word-break: break-all; }
        .file-meta { font-size: 12px; color: var(--text-muted); display: flex; gap: 10px; margin-top: 5px; }
        
        .action-row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
            margin-bottom: 12px;
        }
        .btn-secondary {
            background: var(--bg-input);
            color: var(--text-main);
            padding: 12px;
            border-radius: 12px;
            font-size: 14px;
        }
        .btn-secondary:hover { background: #475569; }

        .qr-wrapper {
            display: flex;
            justify-content: center;
            margin-top: 20px;
            padding: 10px;
            background: white;
            border-radius: 12px;
            width: fit-content;
            margin-left: auto;
            margin-right: auto;
        }

        /* History */
        .history { margin-top: 30px; }
        .history-title { font-size: 13px; color: var(--text-muted); margin-bottom: 12px; display: flex; justify-content: space-between; }
        .history-list { display: flex; flex-direction: column; gap: 8px; }
        .history-item {
            background: rgba(51, 65, 85, 0.4);
            padding: 12px;
            border-radius: 12px;
            display: flex;
            align-items: center;
            gap: 12px;
            cursor: pointer;
            transition: 0.2s;
        }
        .history-item:hover { background: rgba(51, 65, 85, 0.8); }
        .h-icon { font-size: 18px; }
        .h-details { flex: 1; overflow: hidden; }
        .h-name { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .h-url { font-size: 11px; color: var(--text-muted); }

        /* Toast */
        .toast {
            position: fixed;
            bottom: 30px;
            left: 50%;
            transform: translateX(-50%) translateY(100px);
            background: #334155;
            color: white;
            padding: 12px 24px;
            border-radius: 50px;
            box-shadow: 0 10px 15px -3px rgba(0,0,0,0.3);
            font-size: 14px;
            opacity: 0;
            transition: all 0.3s;
            z-index: 100;
            display: flex;
            align-items: center;
            gap: 8px;
            border: 1px solid rgba(255,255,255,0.1);
        }
        .toast.show { transform: translateX(-50%) translateY(0); opacity: 1; }

        /* Animations */
        @keyframes fadeIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes slideUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { 100% { transform: rotate(360deg); } }

        /* Footer */
        .footer {
            margin-top: 24px;
            text-align: center;
            font-size: 12px;
            color: var(--text-muted);
            opacity: 0.6;
        }
        .footer a { color: var(--primary); text-decoration: none; }
    </style>
</head>
<body>

<div class="container">
    <div class="card">
        <div class="header">
            <div class="logo">GitMirror</div>
            <div class="desc">لینک گیت‌هاب را وارد کنید، لینک مستقیم و پرسرعت دریافت کنید</div>
        </div>

        <div class="input-group">
            <div class="input-wrapper">
                <svg class="input-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"></path></svg>
                <input type="text" id="urlInput" placeholder="https://github.com/user/repo/..." spellcheck="false" autocomplete="off">
            </div>
        </div>

        <button id="processBtn" class="btn btn-primary">
            <span id="btnText">بررسی و ساخت لینک</span>
            <svg id="btnLoader" class="spin" style="display:none; width:20px; height:20px;" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
        </button>

        <div id="resultArea" class="result-card">
            <div class="file-info">
                <div>
                    <div class="file-name" id="fileName">File.zip</div>
                    <div class="file-meta">
                        <span id="fileSize">0 MB</span> • <span id="fileType">Archive</span>
                    </div>
                </div>
                <div style="background:var(--success); color:#000; padding:4px 8px; border-radius:6px; font-size:11px; font-weight:bold;">آماده</div>
            </div>

            <div class="action-row">
                <button class="btn btn-secondary" onclick="copyLink('short')">
                    <svg style="width:16px;height:16px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"></path></svg>
                    کپی لینک کوتاه
                </button>
                <button class="btn btn-secondary" onclick="copyLink('long')">
                    <svg style="width:16px;height:16px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"></path></svg>
                    کپی لینک اصلی
                </button>
            </div>

            <button id="dlBtn" class="btn btn-primary" style="background: var(--success); box-shadow: 0 4px 15px rgba(16, 185, 129, 0.3);">
                <svg style="width:20px;height:20px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                دانلود مستقیم
            </button>

            <div class="qr-wrapper" id="qrContainer"></div>
        </div>

        <div class="history">
            <div class="history-title">
                <span>تاریخچه اخیر</span>
                <span style="cursor:pointer; color:var(--error);" onclick="clearHistory()">پاکسازی</span>
            </div>
            <div class="history-list" id="historyList">
                </div>
        </div>
        
        <div class="footer">
            <div>Powered by Cloudflare Workers &bull; Professional Edition</div>
            <div style="margin-top: 4px;">
                <a href="https://github.com/Ptechgithub/GitMirror" target="_blank" style="color: var(--primary); text-decoration: none;">
                    Github 
                </a>
            </div>
</div>
        
    </div>
</div>

<div id="toast" class="toast">
    <svg style="width:20px;height:20px;color:var(--success);" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>
    <span id="toastMsg">عملیات انجام شد</span>
</div>

<script>
    const API_ORIGIN = "${origin}";
    let currentShort = "";
    let currentLong = "";

    const $ = id => document.getElementById(id);

    // Initial Load
    renderHistory();

    // Event Listener
    $('processBtn').addEventListener('click', processUrl);
    $('urlInput').addEventListener('keypress', (e) => { if(e.key === 'Enter') processUrl(); });

    async function processUrl() {
        const url = $('urlInput').value.trim();
        if (!url) return showToast("لطفاً لینک را وارد کنید", true);

        setLoading(true);
        $('resultArea').classList.remove('active');

        try {
            // Parallel: Shorten & Get Meta
            const [metaRes, shortRes] = await Promise.all([
                fetch(API_ORIGIN + "/api/meta?url=" + encodeURIComponent(url)),
                fetch(API_ORIGIN + "/api/shorten", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ url })
                })
            ]);

            const meta = await metaRes.json();
            const short = await shortRes.json();

            if (short.error) throw new Error(short.error);
            
            // Update UI
            $('fileName').textContent = meta.name || url.split('/').pop();
            $('fileSize').textContent = meta.size ? (meta.size / 1024 / 1024).toFixed(2) + " MB" : "ناشناخته";
            $('fileType').textContent = meta.type || "File";
            
            currentShort = API_ORIGIN + "/" + short.short;
            currentLong = API_ORIGIN + "/" + short.long.replace(/^https?:\\/\\//, '');

            // QR Code
            $('qrContainer').innerHTML = "";
            new QRCode($('qrContainer'), {
                text: currentShort,
                width: 100,
                height: 100,
                colorDark : "#000000",
                colorLight : "#ffffff",
                correctLevel : QRCode.CorrectLevel.L
            });

            // Setup Download Button
            $('dlBtn').onclick = () => window.open(currentShort, '_blank');

            // Save to History
            addToHistory({ name: $('fileName').textContent, url: url, date: Date.now() });

            $('resultArea').classList.add('active');
            showToast("لینک با موفقیت آماده شد");

        } catch (err) {
            console.error(err);
            showToast("خطا: " + (err.message || "لینک نامعتبر است"), true);
        } finally {
            setLoading(false);
        }
    }

    function copyLink(type) {
        const txt = type === 'short' ? currentShort : currentLong;
        navigator.clipboard.writeText(txt).then(() => {
            showToast(type === 'short' ? "لینک کوتاه کپی شد" : "لینک پروکسی کپی شد");
        });
    }

    function setLoading(state) {
        const btn = $('processBtn');
        const txt = $('btnText');
        const ldr = $('btnLoader');
        
        btn.disabled = state;
        if (state) {
            txt.style.display = 'none';
            ldr.style.display = 'block';
        } else {
            txt.style.display = 'block';
            ldr.style.display = 'none';
        }
    }

    function showToast(msg, isError = false) {
        const t = $('toast');
        const tm = $('toastMsg');
        tm.textContent = msg;
        t.style.border = isError ? "1px solid #ef4444" : "1px solid rgba(255,255,255,0.1)";
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 3000);
    }

    // History Logic
    function getHistory() { return JSON.parse(localStorage.getItem('gm_history') || '[]'); }
    
    function addToHistory(item) {
        let h = getHistory();
        h = h.filter(i => i.url !== item.url); // remove duplicates
        h.unshift(item);
        if (h.length > 5) h.pop();
        localStorage.setItem('gm_history', JSON.stringify(h));
        renderHistory();
    }

    function clearHistory() {
        localStorage.removeItem('gm_history');
        renderHistory();
    }

    function renderHistory() {
        const h = getHistory();
        const list = $('historyList');
        list.innerHTML = "";
        
        if (h.length === 0) {
            list.innerHTML = '<div style="text-align:center; color:#475569; font-size:12px; padding:10px;">هنوز چیزی دانلود نکرده‌اید</div>';
            return;
        }

        h.forEach(item => {
            const div = document.createElement('div');
            div.className = 'history-item';
            div.innerHTML = \`
                <div class="h-icon">📄</div>
                <div class="h-details">
                    <div class="h-name">\${item.name}</div>
                    <div class="h-url">\${item.url}</div>
                </div>
            \`;
            div.onclick = () => { $('urlInput').value = item.url; processUrl(); };
            list.appendChild(div);
        });
    }
</script>
</body>
</html>`;
}