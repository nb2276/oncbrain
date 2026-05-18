import 'dotenv/config';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { html, raw } from 'hono/html';
import {
  openDb,
  saveBookmark,
  listBookmarks,
  deleteBookmark,
  listConferences,
  upsertConference,
  type Bookmark,
  type Conference,
} from '../src/lib/db.ts';

const app = new Hono();
const db = openDb();

const ADMIN_PORT = parseInt(process.env.ADMIN_PORT || '3001', 10);

function layout(title: string, body: ReturnType<typeof html> | string) {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        <style>
          :root {
            color-scheme: light dark;
            --fg: #111;
            --bg: #fff;
            --muted: #666;
            --border: #ddd;
            --accent: #0066cc;
            --danger: #c33;
          }
          @media (prefers-color-scheme: dark) {
            :root {
              --fg: #eee;
              --bg: #111;
              --muted: #aaa;
              --border: #333;
              --accent: #4a9eff;
              --danger: #f66;
            }
          }
          * { box-sizing: border-box; }
          body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 800px; margin: 2rem auto; padding: 0 1rem; color: var(--fg); background: var(--bg); line-height: 1.5; }
          h1 { margin: 0 0 0.25rem; font-size: 1.5rem; }
          nav { margin: 1rem 0 2rem; padding-bottom: 1rem; border-bottom: 1px solid var(--border); }
          nav a { margin-right: 1rem; color: var(--accent); text-decoration: none; }
          form { display: flex; flex-direction: column; gap: 0.75rem; }
          label { font-size: 0.875rem; color: var(--muted); display: block; margin-bottom: 0.25rem; }
          input, select, textarea, button { font: inherit; padding: 0.5rem; border: 1px solid var(--border); border-radius: 4px; background: var(--bg); color: var(--fg); }
          textarea { resize: vertical; min-height: 4rem; font-family: inherit; }
          button { cursor: pointer; background: var(--accent); color: white; border: none; padding: 0.6rem 1rem; }
          button.danger { background: var(--danger); padding: 0.25rem 0.5rem; font-size: 0.8rem; }
          button[type="submit"]:hover { opacity: 0.9; }
          .row { display: flex; gap: 0.75rem; }
          .row > * { flex: 1; }
          .bookmark { border: 1px solid var(--border); border-radius: 4px; padding: 0.75rem; margin-bottom: 0.5rem; }
          .bookmark .meta { font-size: 0.8rem; color: var(--muted); margin-bottom: 0.25rem; display: flex; justify-content: space-between; align-items: center; }
          .bookmark .text { font-size: 0.95rem; }
          .bookmark a { color: var(--accent); }
          .flash { padding: 0.75rem; border-radius: 4px; margin-bottom: 1rem; background: #efe; border: 1px solid #cfc; color: #060; }
          @media (prefers-color-scheme: dark) {
            .flash { background: #052; border-color: #074; color: #cfc; }
          }
          details summary { cursor: pointer; color: var(--muted); padding: 0.5rem 0; }
          .pill { display: inline-block; padding: 0.1rem 0.4rem; background: var(--border); border-radius: 999px; font-size: 0.75rem; margin-right: 0.25rem; }
        </style>
      </head>
      <body>
        <h1>Oncology Meeting Digest — Admin</h1>
        <nav>
          <a href="/">Add bookmark</a>
          <a href="/bookmarks">Queue</a>
          <a href="/conferences">Conferences</a>
        </nav>
        ${body}
      </body>
    </html>`;
}

app.get('/', (c) => {
  const flash = c.req.query('flash');
  const conferences = listConferences(db);
  return c.html(
    layout(
      'Add bookmark',
      html`
        ${flash ? html`<div class="flash">${flash}</div>` : ''}
        <form method="post" action="/bookmark">
          <div>
            <label for="url">Tweet URL</label>
            <input id="url" name="url" type="url" required placeholder="https://x.com/handle/status/..." autofocus />
          </div>
          <div class="row">
            <div>
              <label for="conference_slug">Conference</label>
              <select id="conference_slug" name="conference_slug" required>
                <option value="">— select —</option>
                ${raw(conferences.map((c) => `<option value="${c.slug}">${c.name}</option>`).join(''))}
              </select>
            </div>
            <div>
              <label for="day">Day</label>
              <input id="day" name="day" type="number" min="1" max="14" required value="1" />
            </div>
          </div>
          <div>
            <label for="notes">Notes (optional)</label>
            <textarea id="notes" name="notes" placeholder="Why is this important? (curator's note)"></textarea>
          </div>
          <details>
            <summary>Manual paste fallback (use when oEmbed fails)</summary>
            <div style="margin-top: 0.75rem; display: flex; flex-direction: column; gap: 0.75rem;">
              <div class="row">
                <div>
                  <label for="author_handle">Author handle</label>
                  <input id="author_handle" name="author_handle" type="text" placeholder="@handle" />
                </div>
                <div>
                  <label for="author_name">Author name</label>
                  <input id="author_name" name="author_name" type="text" placeholder="Joe Jones, MD" />
                </div>
              </div>
              <div>
                <label for="tweet_text">Tweet text</label>
                <textarea id="tweet_text" name="tweet_text" placeholder="Paste the tweet text here"></textarea>
              </div>
            </div>
          </details>
          <button type="submit">Add to queue</button>
        </form>
        ${
          conferences.length === 0
            ? html`<p style="margin-top:2rem;color:var(--muted)">
                No conferences yet —
                <a href="/conferences">add one</a>
                first.
              </p>`
            : ''
        }
      `,
    ),
  );
});

app.post('/bookmark', async (c) => {
  const form = await c.req.formData();
  const url = String(form.get('url') || '').trim();
  const conference_slug = String(form.get('conference_slug') || '').trim();
  const day = parseInt(String(form.get('day') || '0'), 10);
  const notes = String(form.get('notes') || '').trim() || null;
  const author_handle = String(form.get('author_handle') || '').trim() || null;
  const author_name = String(form.get('author_name') || '').trim() || null;
  const tweet_text = String(form.get('tweet_text') || '').trim() || null;

  if (!url || !conference_slug || !day) {
    return c.redirect('/?flash=' + encodeURIComponent('Missing required fields'));
  }

  // If manual fields are provided, mark as 'manual'. Otherwise pending (fetched later by build pipeline).
  const fetched_via = tweet_text || author_handle ? 'manual' : 'pending';

  const result = saveBookmark(db, {
    url,
    conference_slug,
    day,
    author_handle,
    author_name,
    tweet_text,
    notes,
    fetched_via,
  });

  const msg = result.created ? `Saved bookmark #${result.id}` : `Already saved (#${result.id}) — no duplicate created`;
  return c.redirect('/?flash=' + encodeURIComponent(msg));
});

app.get('/bookmarks', (c) => {
  const bookmarks = listBookmarks(db);
  const conferenceMap = new Map(listConferences(db).map((c) => [c.slug, c]));

  return c.html(
    layout(
      'Queue',
      html`
        <p style="color:var(--muted)">${bookmarks.length} bookmark${bookmarks.length === 1 ? '' : 's'} in queue.</p>
        ${
          bookmarks.length === 0
            ? html`<p>Nothing yet. <a href="/">Add a bookmark</a>.</p>`
            : raw(
                bookmarks
                  .map(
                    (b: Bookmark) => `
            <div class="bookmark">
              <div class="meta">
                <span>
                  <span class="pill">${conferenceMap.get(b.conference_slug)?.name ?? b.conference_slug}</span>
                  <span class="pill">Day ${b.day}</span>
                  <span class="pill">${b.fetched_via}</span>
                  ${b.author_handle ? `<span style="color:var(--muted)">${b.author_handle}</span>` : ''}
                </span>
                <form method="post" action="/delete/${b.id}" style="display:inline" onsubmit="return confirm('Delete this bookmark?')">
                  <button type="submit" class="danger">delete</button>
                </form>
              </div>
              ${b.tweet_text ? `<div class="text">${escapeHtml(b.tweet_text)}</div>` : ''}
              ${b.notes ? `<div class="text" style="margin-top:0.5rem;color:var(--muted);font-style:italic">Note: ${escapeHtml(b.notes)}</div>` : ''}
              <div style="margin-top:0.5rem;font-size:0.8rem"><a href="${escapeAttr(b.url)}" target="_blank" rel="noopener">view original →</a></div>
            </div>
          `,
                  )
                  .join(''),
              )
        }
      `,
    ),
  );
});

app.post('/delete/:id', (c) => {
  const id = parseInt(c.req.param('id'), 10);
  deleteBookmark(db, id);
  return c.redirect('/bookmarks');
});

app.get('/conferences', (c) => {
  const conferences = listConferences(db);
  const flash = c.req.query('flash');
  return c.html(
    layout(
      'Conferences',
      html`
        ${flash ? html`<div class="flash">${flash}</div>` : ''}
        <form method="post" action="/conferences">
          <div class="row">
            <div>
              <label for="slug">Slug</label>
              <input id="slug" name="slug" type="text" required placeholder="asco2026" pattern="[a-z0-9-]+" />
            </div>
            <div>
              <label for="name">Name</label>
              <input id="name" name="name" type="text" required placeholder="ASCO Annual Meeting 2026" />
            </div>
          </div>
          <div class="row">
            <div>
              <label for="start_date">Start date</label>
              <input id="start_date" name="start_date" type="date" />
            </div>
            <div>
              <label for="end_date">End date</label>
              <input id="end_date" name="end_date" type="date" />
            </div>
            <div>
              <label for="hashtag">Hashtag</label>
              <input id="hashtag" name="hashtag" type="text" placeholder="#ASCO26" />
            </div>
          </div>
          <button type="submit">Add / update conference</button>
        </form>
        <h2 style="margin-top:2rem;font-size:1.1rem">Existing</h2>
        ${
          conferences.length === 0
            ? html`<p style="color:var(--muted)">None yet.</p>`
            : raw(
                conferences
                  .map(
                    (c: Conference) => `
            <div class="bookmark">
              <div class="meta">
                <span><strong>${escapeHtml(c.name)}</strong> <span class="pill">${c.slug}</span></span>
              </div>
              <div style="color:var(--muted);font-size:0.85rem">
                ${c.start_date || '?'} → ${c.end_date || '?'}
                ${c.hashtag ? ` · ${escapeHtml(c.hashtag)}` : ''}
              </div>
            </div>
          `,
                  )
                  .join(''),
              )
        }
      `,
    ),
  );
});

app.post('/conferences', async (c) => {
  const form = await c.req.formData();
  const slug = String(form.get('slug') || '').trim();
  const name = String(form.get('name') || '').trim();
  const start_date = String(form.get('start_date') || '').trim() || null;
  const end_date = String(form.get('end_date') || '').trim() || null;
  const hashtag = String(form.get('hashtag') || '').trim() || null;
  if (!slug || !name) return c.redirect('/conferences?flash=' + encodeURIComponent('Missing slug or name'));
  upsertConference(db, { slug, name, start_date, end_date, hashtag });
  return c.redirect('/conferences?flash=' + encodeURIComponent(`Saved conference: ${name}`));
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

serve({ fetch: app.fetch, port: ADMIN_PORT }, (info) => {
  console.log(`Admin running at http://localhost:${info.port}`);
});
