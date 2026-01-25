import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { Client as FtpClient } from 'basic-ftp';
import SftpClient from 'ssh2-sftp-client';
import { Readable } from 'stream';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const PORT = Number(process.env.PORT) || 3010;
const FTP_HOST = (process.env.FTP_HOST || '')
  .replace(/^https?:\/\//i, '')
  .replace(/\/.*$/, '')
  .trim();
const FTP_PORT = Number(process.env.FTP_PORT) || 21;
const FTP_USER = process.env.FTP_USER || '';
const FTP_PASSWORD = process.env.FTP_PASSWORD || '';
const FTP_USE_SFTP = /^(1|true|yes)$/i.test(process.env.FTP_USE_SFTP || '');
const FTP_SECURE = /^(1|true|yes)$/i.test(process.env.FTP_SECURE || '');
const FTP_BASE_PATH = (process.env.FTP_BASE_PATH || '').replace(/\/+$/, '');
const FTP_FLAT_UPLOAD = /^(1|true|yes)$/i.test(process.env.FTP_FLAT_UPLOAD || '');

const upload = multer({ storage: multer.memoryStorage() });

function sanitize(s) {
  return String(s || '')
    .replace(/[/\\*?"<>|]/g, '_')
    .replace(/\.\./g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 200) || 'unnamed';
}

/** שומר את הנתיב כמו שהוא – רק \\ ל־/ והסרת .. (אבטחה). עבור העלאת תיקייה. */
function usePathAsIs(p) {
  if (p == null || String(p).trim() === '') return 'file';
  const parts = String(p)
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '' && s !== '..');
  return parts.join('/') || 'file';
}

function ftpErrorMsg(raw) {
  const s = String(raw || '').toLowerCase();
  if (/address lookup failed|getaddrinfo|unknown host|enotfound/i.test(s)) {
    return (
      'לא נמצא המארח (FTP_HOST). השתמש רק ב-domain ללא https:// – למשל cloud.intorya.com. ' +
      'ודא שהשם זהה למה שב-FileZilla.'
    );
  }
  if (/refused|econnrefused|econnreset|etimedout|network|unreachable/i.test(s)) {
    return (
      'השרת המרוחק (FTP/SFTP) דחה או חסם את החיבור. בדוק: ' +
      '1) SFTP או FTP? התאם FTP_USE_SFTP. פורט: SFTP=22, FTP=21. ' +
      '2) מארח ופורט זהים ל-FileZilla. ' +
      '3) חומת אש / הגבלות IP אצל ספק האחסון.'
    );
  }
  if (/550|no such file or directory|file unavailable/i.test(s)) {
    return (
      'תיקייה לא נמצאה (550). וודא ש-FTP_BASE_PATH מצביע לתיקייה **קיימת** – צור אותה ב-FileZilla אם צריך. ' +
      'למשל: צור תיקייה games בתוך public_html, אז הגדר FTP_BASE_PATH=games.'
    );
  }
  return raw;
}

async function uploadViaFtp(files, category, gameName, key, relativePaths) {
  const client = new FtpClient(60_000);

  await client.access({
    host: FTP_HOST,
    port: FTP_PORT,
    user: FTP_USER,
    password: FTP_PASSWORD,
    secure: FTP_SECURE,
    secureOptions: { rejectUnauthorized: false },
    allowSeparateTransferHost: false,
    pasv: true,
  });

  try {
    if (FTP_BASE_PATH) {
      const parts = FTP_BASE_PATH.split('/').filter(Boolean);
      for (const p of parts) {
        await client.cd(p);
      }
    }
    if (FTP_FLAT_UPLOAD) {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const rawPath = relativePaths?.[i];
        const name = f.originalname || f.name || 'file';
        const remotePath = rawPath ? usePathAsIs(rawPath) : sanitize(name);
        const stream = Readable.from(f.buffer);
        if (remotePath.includes('/')) {
          const dir = remotePath.replace(/\/[^/]+$/, '');
          const baseName = remotePath.replace(/^.*\//, '');
          await client.ensureDir(dir);
          await client.uploadFrom(stream, baseName);
          for (let k = 0; k < dir.split('/').length; k++) {
            await client.cd('..');
          }
        } else {
          await client.uploadFrom(stream, remotePath);
        }
      }
    } else {
      const relDir = [sanitize(category), sanitize(gameName)].join('/');
      await client.ensureDir(relDir);
      for (const f of files) {
        const name = sanitize(f.originalname || f.name || 'file');
        const remote = relDir + '/' + name;
        const stream = Readable.from(f.buffer);
        await client.uploadFrom(stream, remote);
      }
    }
  } finally {
    client.close();
  }
}

async function uploadViaSftp(files, category, gameName, key) {
  const segments = [FTP_BASE_PATH, sanitize(category), sanitize(gameName)].filter(Boolean);
  const base = segments.length ? '/' + segments.join('/') : '/';

  const sftp = new SftpClient();
  await sftp.connect({
    host: FTP_HOST,
    port: FTP_PORT,
    username: FTP_USER,
    password: FTP_PASSWORD,
  });

  try {
    let acc = '';
    for (const p of segments) {
      acc = acc ? acc + '/' + p : '/' + p;
      try {
        await sftp.mkdir(acc);
      } catch (e) {
        if (e.message && !/exist|already exists/i.test(String(e.message))) throw e;
      }
    }
    for (const f of files) {
      const name = sanitize(f.originalname || f.name || 'file');
      const remote = base + '/' + name;
      await sftp.put(Buffer.from(f.buffer), remote);
    }
  } finally {
    await sftp.end();
  }
}

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

app.get('/health', (_, res) => {
  res.json({ ok: true, service: 'games-upload-server' });
});

app.get('/test-connection', async (_, res) => {
  if (!FTP_HOST || !FTP_USER) {
    return res.status(400).json({
      ok: false,
      error: 'חסר FTP_HOST או FTP_USER ב-.env',
    });
  }
  try {
    if (FTP_USE_SFTP) {
      const sftp = new SftpClient();
      await sftp.connect({
        host: FTP_HOST,
        port: FTP_PORT,
        username: FTP_USER,
        password: FTP_PASSWORD,
      });
      await sftp.end();
    } else {
      const client = new FtpClient(10_000);
      await client.access({
        host: FTP_HOST,
        port: FTP_PORT,
        user: FTP_USER,
        password: FTP_PASSWORD,
        secure: FTP_SECURE,
        secureOptions: { rejectUnauthorized: false },
      });
      client.close();
    }
    return res.json({ ok: true, message: 'חיבור הצליח' });
  } catch (err) {
    const raw = err?.message || String(err);
    console.error('Test connection error:', raw);
    const hint =
      FTP_USE_SFTP && FTP_PORT === 21
        ? ' SFTP משתמש בדרך כלל בפורט 22 – נסה FTP_PORT=22.'
        : '';
    return res.status(500).json({
      ok: false,
      error: raw,
      hint: hint || undefined,
    });
  }
});

app.post('/upload', (req, res, next) => {
  upload.array('files', 500)(req, res, (err) => {
    if (err) {
      console.error('Multer error:', err);
      return res.status(400).json({
        error: err.message || 'שגיאה בקבלת הקבצים',
      });
    }
    next();
  });
}, async (req, res) => {
  try {
    const files = req.files || [];
    const category = req.body?.category ?? '';
    const gameName = req.body?.gameName ?? '';
    let relativePaths;
    try {
      const raw = req.body?.relativePaths;
      relativePaths = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!Array.isArray(relativePaths)) relativePaths = undefined;
    } catch {
      relativePaths = undefined;
    }

    if (!FTP_HOST || !FTP_USER) {
      return res.status(500).json({
        error: 'חסר תצורת FTP. צור upload-server/.env עם FTP_HOST, FTP_USER, FTP_PASSWORD (אותם פרטים מ-FileZilla).',
      });
    }
    if (!category || !gameName) {
      return res.status(400).json({ error: 'נדרשים שדות category ו-gameName' });
    }
    if (files.length === 0) {
      return res.status(400).json({ error: 'לא נשלחו קבצים' });
    }

    if (FTP_USE_SFTP) {
      await uploadViaSftp(files, category, gameName, req.body?.key);
    } else {
      await uploadViaFtp(files, category, gameName, req.body?.key, relativePaths);
    }

    res.json({
      ok: true,
      uploaded: files.length,
      path: FTP_FLAT_UPLOAD
        ? (FTP_BASE_PATH || '(root)')
        : [FTP_BASE_PATH, sanitize(category), sanitize(gameName)].filter(Boolean).join('/'),
    });
  } catch (err) {
    const raw = err?.message || String(err);
    console.error('Upload error:', raw);
    let msg = ftpErrorMsg(raw);
    if (FTP_USE_SFTP && FTP_PORT === 21) {
      msg += ' טיפ: SFTP משתמש בדרך כלל בפורט 22 – נסה FTP_PORT=22.';
    }
    res.status(500).json({ error: msg, rawError: raw });
  }
});

app.listen(PORT, () => {
  console.log(`Upload server: http://localhost:${PORT}`);
  console.log(`FTP: ${FTP_USE_SFTP ? 'SFTP' : 'FTP'} ${FTP_HOST || '(לא הוגדר)'}:${FTP_PORT}`);
  if (!FTP_HOST || !FTP_USER) {
    console.warn('אזהרה: חסרה תצורת FTP. צור upload-server/.env עם FTP_HOST, FTP_USER, FTP_PASSWORD.');
  }
  if (FTP_USE_SFTP && FTP_PORT === 21) {
    console.warn('אזהרה: SFTP בדרך כלל משתמש בפורט 22. אם החיבור נכשל, נסה FTP_PORT=22.');
  }
});
