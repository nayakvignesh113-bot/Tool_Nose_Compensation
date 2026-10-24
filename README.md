# Tool Nose Radius Compensation: video lesson with tracking

| File | What it is |
|---|---|
| `index.html` | Student page: narrated animated video (5 min 47 s), 8 MCQ checkpoints, auto-saved progress, results and review |
| `dashboard.html` | Instructor dashboard (login): KPIs, score distribution, video drop-off, item analysis, per-student detail, Excel/CSV export, publication-style PNG charts |
| `config.js` | Supabase URL + publishable key + module id |
| `assets/` | `tnrc-lesson.mp4` (720p, 12 MB), `captions.vtt`, `timeline.json` (checkpoint times), `poster.jpg` |
| `supabase/setup.sql` | Database: tables, security rules, grading functions, the 8 questions + answer key |
| `source/` | Script/MCQs (`lesson.py`, `lesson.json`), narration (`tts.py`, Kokoro TTS), renderer (`render.mjs`) to regenerate the video |

## 1. Database (one time, ~1 min)
1. Supabase → **midastouch (Nikasha)** project → **SQL Editor** → New query.
2. Paste all of `supabase/setup.sql` → **Run**. It only creates `cnc_*` objects and is safe to re-run.
3. The dashboard login is your existing Nikasha account **nayak.vignesh113@gmail.com**. To add another teacher, run
   `insert into cnc_instructors(email) values ('someone@mite.ac.in');` (they need a confirmed account in that project).

## 2. Host on GitHub Pages
1. Create a repo (e.g. `tnrc-lesson`), upload everything in this folder *except* `source/` (optional), and commit.
2. Repo → Settings → Pages → Deploy from branch → `main` / root.
3. Students get: `https://<user>.github.io/tnrc-lesson/`. You use: `…/tnrc-lesson/dashboard.html`.

## How it works / integrity
- Students enter USN + name (USN format checked). Questions are fetched from the server **without the answer key**; grading happens in the database. The **first answer counts**; feedback and the explanation show only after submitting.
- Video can't be skipped past the furthest point watched; skip attempts, leaving the tab, rewinds, the parts of the video actually watched and time on page are all logged.
- Wrong answer → "Rewatch this part" jumps back to that chapter.
- Closing the browser keeps progress; reopening offers **Resume**. Students may retake (new attempt); the dashboard analyses first / best / latest attempt.
- Dashboard: **Lesson open/closed** toggle, live view (30 s refresh), delete test attempts, Excel export (Summary, Students, Attempts, Responses, Item analysis, Score distribution, Retention), and "PNG (publication)" charts (Times New Roman, bold, B&W, symbols, closed box). The same data sits in the Excel file.
- "Preview with sample data" on the login page shows the dashboard with 64 synthetic students.

## Adding the next lesson
Edit `source/lesson.py` (narration + MCQs), run `python3 tts.py`, then `node render.mjs`, insert a new module id + questions (copy the seed block in `setup.sql`), and set `MODULE_ID` in `config.js` of a copied folder.
