# שרת העלאת קבצים ל-FTP/SFTP

שרת Node.js שמקבל קבצים דרך HTTP ומעלה אותם לשרת קבצים (FTP או SFTP) – כמו ההתחברות ב-FileZilla.

## הרצה

```bash
cd upload-server
npm install
```

צור קובץ `.env` בתיקייה (ראה מטה) וערוך את הפרטים לפי שרת הקבצים שלך.

```bash
npm start
```

במצב פיתוח עם ריענון אוטומטי:

```bash
npm run dev
```

## תצורת `.env`

צור קובץ `.env` בתיקיית `upload-server` עם המשתנים הבאים (אותם פרטים שמשמשים אותך ב-FileZilla – מארח, פורט, משתמש, סיסמה):

| משתנה | חובה | תיאור |
|-------|------|--------|
| `PORT` | לא | פורט שרת ההעלאה (ברירת מחדל: 3010) |
| `FTP_HOST` | כן | מארח בלבד, **בלי** `https://` (למשל `cloud.intorya.com`) |
| `FTP_PORT` | כן | פורט (21 ל-FTP, 22 בדרך כלל ל-SFTP) |
| `FTP_USER` | כן | שם משתמש |
| `FTP_PASSWORD` | כן | סיסמה |
| `FTP_USE_SFTP` | לא | `true` רק ב-SFTP. **ל-FTP רגיל (פורט 21) השאר `false`**. |
| `FTP_SECURE` | לא | `true` ל-FTPS (FTP over TLS). רק כש-`FTP_USE_SFTP` = false |
| `FTP_BASE_PATH` | לא | נתיב **יחסי לשורש** שאתה רואה ב-FileZilla. השרת עושה `cd` לכל חלק (למשל `public_html` ואז `games`). אם יש `public_html/games`, הגדר `FTP_BASE_PATH=public_html/games`. |
| `FTP_FLAT_UPLOAD` | לא | `true` = מעלה קבצים **ישר** ל-BASE_PATH בלי תיקיות קטגוריה/משחק, רק שם הקובץ המקורי. `false` = יוצר `קטגוריה/שם_משחק/` ומעלה לשם. |

דוגמה ל-SFTP (כמו ב-FileZilla עם SFTP):

```
PORT=3010
FTP_HOST=ftp.example.com
FTP_PORT=22
FTP_USER=myuser
FTP_PASSWORD=mypass
FTP_USE_SFTP=true
FTP_BASE_PATH=/games
```

דוגמה ל-FTP רגיל:

```
PORT=3010
FTP_HOST=ftp.example.com
FTP_PORT=21
FTP_USER=myuser
FTP_PASSWORD=mypass
FTP_USE_SFTP=false
```

## חיבור מהאפליקציה

בפרויקט הראשי (אפליקציית React) הוסף ל-`.env`:

```
VITE_GAME_FILES_UPLOAD_URL=http://localhost:3010/upload
```

כשהשרת רץ על מכונה אחרת, השתמש בכתובת המלאה, למשל:

```
VITE_GAME_FILES_UPLOAD_URL=https://upload.yourserver.com/upload
```

## API

- **GET /health** – בדיקת פעילות.
- **GET /test-connection** – בודק חיבור ל-FTP/SFTP (בלי להעלות קבצים). מועיל לאיתור שגיאות תצורה. פתח בדפדפן: `http://localhost:3010/test-connection`.
- **POST /upload** – העלאת קבצים.  
  `Content-Type: multipart/form-data` עם:
  - `files` – קבצים (ריבוי)
  - `category` – מזהה קטגוריה
  - `gameName` – שם המשחק
  - `key` – מפתח (אופציונלי)

הקבצים נשמרים בנתיב: `{FTP_BASE_PATH}/{category}/{gameName}/{filename}`.

## "Remote host refused connection" / החיבור נדחה

כשמופיעה שגיאה כזו, השרת המרוחק (FTP/SFTP) דוחה את החיבור. בדוק:

1. **SFTP או FTP?** ב-FileZilla, איך אתה מתחבר? אם ב-SFTP – `FTP_USE_SFTP=true` ו-`FTP_PORT=22`. אם ב-FTP – `FTP_USE_SFTP=false` ו-`FTP_PORT=21`.
2. **מארח ופורט** – `FTP_HOST` ו-`FTP_PORT` חייבים להיות **זהים** למה שמשמש ב-FileZilla (כתובת השרת, פורט).
3. **FTPS (FTP מאובטח)** – אם ב-FileZilla אתה בוחר "מאובטח" / TLS: `FTP_SECURE=true`. ל-FTPS Implicit (פורט 990) יש צורך בהתאמה נוספת.
4. **חומת אש / הגבלת IP** – ספק האחסון עלול לאפשר חיבור רק מכתובות מסוימות. וודא שהמכונה שרצה עליה את `upload-server` (בדרך כלל אותה מחשב שבו FileZilla עובד) מורשת.

5. **test-connection עובד אבל העלאה נכשלת?** – לרוב זו בעיית **חיבור נתונים** (passive mode). שרתים מאחורי NAT מחזירים כתובת פנימית ב-PASV. הקוד מגדיר `allowSeparateTransferHost: false` כדי להשתמש באותו מארח כמו חיבור הבקרה – הפעל מחדש את השרת ונסה שוב.
