# Migrating from 3.x to 4.0 (web)

4.0 keeps the 3.x API (Client, Model, Session, Heads, Backend) with two options fewer (analytics and audience, below).
What changes is where it runs: a hosted loader opens Quran Lab's frame on your page, and the engine, the model and
its lease live in that frame's Worker. Most pages change the script tag, add the Content-Security-Policy lines of the
README, and remove the analytics and audience options if they set them.

**When to move.** SDK 3.x stops receiving the V4 model on 15 January 2027, 00:00 UTC. New model versions, from V4.1
on, are published only encrypted, for SDK 4.0: a page on 3.x never gets them.

| 3.x | 4.0 |
| --- | --- |
| `npm install @quran-lab/tajweedformer@^3`: the engine and the model files came through your page. | `<script src="https://web.quranlab.ai/4/loader.js">`, or the npm package `@^4`, a thin wrapper that loads the same loader. The engine and the model stay in Quran Lab's frame. |
| `TajweedClient.create({ key, analytics: 'off' })` turned the anonymous analytics off. | The option is gone: anonymous analytics are always on, because they are daily counts and durations only, never audio, text, names or device identifiers. Remove the option: passing it, whatever its value, is refused with `invalid_argument`, whose message points to this guide. Only Quran Lab can switch them off, from its signed config. |
| `TajweedClient.create({ key, audience })` chose a sharing sheet. | `audience` is removed: delete the option. Every app shows the same sharing sheet. Passing it, whatever its value, is refused with `invalid_argument`, whose message points to this guide. Complying with children's privacy law is the app's and the app store's, through the app's privacy policy and its store declarations. |
| A Content-Security-Policy needed nothing for the SDK beyond its files. | Add the `script-src`, `frame-src` and `connect-src` lines of the README's "The Content-Security-Policy lines your site needs" (both hosts, `web.quranlab.ai` and `web2.quranlab.ai`). |
| The model, once in the browser's cache, opened with no connection. | The first visit needs a connection; after that the model opens with no connection, as in 3.x, and while online the SDK keeps itself up to date in the background. The model's encrypted files stay cached for your site, so a later visit does not download them again. See "The protected model". |
| A config that did not verify, or had expired, was `needs_connection` (up to 3.1.6). | `needs_connection` only when Quran Lab gave no answer at all. See "Error codes". |
| The SDK asked to share at most three times, a re-ask 7 sessions after "Not now". | The first ask (the full sheet) never right after the install nor before the 3rd completed take, at the end of a good session; a re-ask is a small card, much later; still three at most. `client.sharing.ask()` shows something only when an ask is due, else resolves with null. |
| Node ran the SDK with a desktop key and `appId`. | The same: the package's Node entry runs the same API with a desktop key and `appId`, in a worker thread, with no frame. The first run needs a connection; after that it works offline, as on the web. See the README's "Node". |

## The protected model

- **In Quran Lab's frame.** The model, its key and its files live in the frame's Worker on Quran Lab's origin. Your
  page's scripts, other scripts on it and extensions limited to your site cannot read them. Only ciphertext is stored,
  in the frame's storage for your site.
- **A lease kept across page loads.** The Worker makes the install keys (WebCrypto, not extractable) and asks Quran
  Lab for a lease, the permission to open the model here. It passes Cloudflare Turnstile inside the frame, invisibly:
  a learner never sees a check or a box. When the check gives no answer or Turnstile is down, the learner still gets
  a lease. The first visit needs a connection; after that the model opens offline. The keys, the lease and the Core's
  state are kept in the frame's storage for your site (sealed under a non-extractable key), so a reload opens the
  model with no request to Quran Lab, also offline; while the device is online the SDK keeps itself up to date in the
  background. A refusal from Quran Lab makes the page ask again. The lease names your site, so a lease taken through
  one site's frame never opens the model under another.
- **Two hosts.** The frame is served from `web.quranlab.ai` and, on a separate route and server, from
  `web2.quranlab.ai`, which the loader uses when the first can't be reached. Each host keeps its own storage, so a page served by the second host downloads the
  model once there too.
- **Downloads go on.** A download that stalls for 30 seconds or breaks goes on from the bytes it has, up to 5 times
  in a call, and a later call goes on from the 4 MB blocks kept.
- **A Model already open keeps running** until it is closed.
- **A wrong device clock changes nothing.** The lease is judged by the Core's clock, anchored at the server's time.
- **The honest limit.** A model that runs on a device can be taken by someone who controls that device and has the
  skill and the time. The goal of 4.0 is that a key, an AI agent, a copied folder or a script gets nothing usable, and
  that taking the model needs an expert, weeks, and a new effort for every release.

## Error codes

The catalogue is the same 26 codes, so code that checks `error.code` works as before. What changes is which code a
failure gets: an answer from a server is never `needs_connection`.

| What happened | Code |
| --- | --- |
| Quran Lab's frame did not answer on either host within 20 seconds (offline, or blocked by the page's Content-Security-Policy) | `needs_connection` from `create()` |
| A request the call needs got no answer at all and nothing of the model is on the device yet | `needs_connection` |
| The SDK needs Quran Lab to continue and Quran Lab gave no answer | `needs_connection` |
| Quran Lab answered with a failure: a server error, a 429, a redirect, a config that does not verify or has expired with none stored | `download_failed`; the message names what answered ("the server answered 503"). Call again later |
| Quran Lab refused the key or the site | `invalid_key`, or `server_rejected` with the reason, as in 3.x; `sdk_too_old` when the key needs a newer SDK |
| The browser cannot verify or run the engine | `runtime_unsupported` |

## Error reports

New in 4.0. Every error the loader gives your page, except the codes that only say the API was used wrongly
(`invalid_argument`, `client_exists`, `session_open`, `session_closed`, `cancelled`), and every failure the SDK goes
on from without telling your page (for example a store the browser blocks, so the model is downloaded at every visit),
is sent to Quran Lab by the frame as one small report: where it failed, why, the HTTP status, the error's name, how
often that day, and what the browser can do (its family and major version, the OS family, mobile or not, WebAssembly
features, the memory and free-space buckets the browser gives). Never the user agent string, a message, a URL or an
identifier. One report per kind of failure per day, with its count; a few a day at most, and old ones are dropped. When
the frame never answered (offline, a policy that blocks it), the next frame that answers sends the report. Your app's
page at sdk.quranlab.ai lists them under Problems, with what to do. No option turns them off; Quran Lab can, from its
signed config. A failed download is also counted in the day's analytics, with its reason.

## Sharing

- **Every learner is asked; the choice is theirs.** Every learner of every app is asked, under the rules above, and
  can say "Not now", turn sharing off, or delete what they shared at any time. There is no option to turn the ask off,
  and no app is exempt. Quran Lab's signed config keeps one switch, a global incident switch that pauses sharing for
  every app at once.
- **Takes in a row.** A shared recording now stays open for up to 60 seconds after a take (3 seconds unless Quran
  Lab's config sets it), so a learner who pauses between turns gives one recording. Nothing to change.
- The sheet (`<quranlab-consent>`), the settings (`<quranlab-sharing-settings>`) and `client.sharing` run in your
  page as in 3.x, loaded by the loader as a chunk it checks.

## What stays the same

The five names, every call of a take, the Heads and the decoded layer, events, `reportRecited` (now the fallback for a
take the SDK could not place, and it takes your app's own judgement with `outcome` and `perAyah`), one Client per
page, the microphone in your page, the learner's earlier answer with the consent version they agreed to, and the 26
error codes. Quran Lab encourages, but does not require, one line where your page shows feedback built on the model,
for example: "Automatic tajweed feedback can be wrong. It does not replace a qualified teacher."
