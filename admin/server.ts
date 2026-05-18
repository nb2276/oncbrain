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
  todayIso,
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
          .day-header { margin: 2rem 0 0.75rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: baseline; }
          .day-header h2 { margin: 0; font-size: 1.05rem; font-weight: 600; }
          .day-header span { font-size: 0.85rem; color: var(--muted); }
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
  const today = todayIso();
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
              <label for="bookmark_date">Date</label>
              <input id="bookmark_date" name="bookmark_date" type="date" required value="${today}" />
            </div>
            <div>
              <label for="conference_slug">Conference (optional)</label>
              <select id="conference_slug" name="conference_slug">
                <option value="">— none —</option>
                ${raw(conferences.map((c) => `<option value="${escapeAttr(c.slug)}">${escapeHtml(c.name)}</option>`).join(''))}
              </select>
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
      `,
    ),
  );
});

app.post('/bookmark', async (c) => {
  const form = await c.req.formData();
  const url = String(form.get('url') || '').trim();
  const bookmark_date = String(form.get('bookmark_date') || '').trim() || todayIso();
  const conference_slug = String(form.get('conference_slug') || '').trim() || null;
  const notes = String(form.get('notes') || '').trim() || null;
  const author_handle = String(form.get('author_handle') || '').trim() || null;
  const author_name = String(form.get('author_name') || '').trim() || null;
  const tweet_text = String(form.get('tweet_text') || '').trim() || null;

  if (!url) {
    return c.redirect('/?flash=' + encodeURIComponent('Missing tweet URL'));
  }

  const fetched_via = tweet_text || author_handle ? 'manual' : 'pending';

  try {
    const result = saveBookmark(db, {
      url,
      bookmark_date,
      conference_slug,
      author_handle,
      author_name,
      tweet_text,
      notes,
      fetched_via,
    });
    const msg = result.created
      ? `Saved bookmark #${result.id} for ${bookmark_date}`
      : `Already saved (#${result.id}) — no duplicate`;
    return c.redirect('/?flash=' + encodeURIComponent(msg));
  } catch (err) {
    return c.redirect('/?flash=' + encodeURIComponent(`Error: ${(err as Error).message}`));
  }
});

app.get('/bookmarks', (c) => {
  const bookmarks = listBookmarks(db);
  const conferenceMap = new Map(listConferences(db).map((c) => [c.slug, c]));

  // Group bookmarks by date for a date-headed queue view.
  const byDate = new Map<string, Bookmark[]>();
  for (const b of bookmarks) {
    const list = byDate.get(b.bookmark_date) ?? [];
    list.push(b);
    byDate.set(b.bookmark_date, list);
  }

  return c.html(
    layout(
      'Queue',
      html`
        <p style="color:var(--muted)">${bookmarks.length} bookmark${bookmarks.length === 1 ? '' : 's'} total.</p>
        ${
          bookmarks.length === 0
            ? html`<p>Nothing yet. <a href="/">Add a bookmark</a>.</p>`
            : raw(
                Array.from(byDate.entries())
                  .map(([date, items]) => {
                    const conf = items.find((b) => b.conference_slug)?.conference_slug;
                    const confName = conf ? conferenceMap.get(conf)?.name : null;
                    return `
              <div class="day-header">
                <h2>${date}${confName ? ` · ${escapeHtml(confName)}` : ''}</h2>
                <span>${items.length} bookmark${items.length === 1 ? '' : 's'}</span>
              </div>
              ${items
                .map(
                  (b) => `
                <div class="bookmark">
                  <div class="meta">
                    <span>
                      ${b.conference_slug ? `<span class="pill">${escapeHtml(conferenceMap.get(b.conference_slug)?.name ?? b.conference_slug)}</span>` : ''}
                      <span class="pill">${b.fetched_via}</span>
                      ${b.author_handle ? `<span style="color:var(--muted)">${escapeHtml(b.author_handle)}</span>` : ''}
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
                .join('')}
            `;
                  })
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
        <p style="color:var(--muted);margin-top:0">
          Optional. Tag bookmarks with a conference to get a conference badge on the published digest and an index page at
          <code>/conferences/&lt;slug&gt;/</code>.
        </p>
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
                <span><strong>${escapeHtml(c.name)}</strong> <span class="pill">${escapeHtml(c.slug)}</span></span>
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
