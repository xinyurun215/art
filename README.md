# Brand pop-up experience design agent

For experience designers and creative planners on small teams. It turns a client brief and cultural research into an early brand pop-up proposal that can be discussed, edited, and traced. The formal product name is not decided.

What is saved now is a stage implementation: the official runtime, the workspace, partial revision and review, field locks, Markdown export, and a Vercel + Postgres deployment adapter. **The complete product has not passed acceptance.** The default offline demo uses a simulated model and synthetic fixtures. It does not mean a live model succeeded.

Product scope is [PRODUCT.md](docs/PRODUCT.md). A short validation record is [VALIDATION.md](docs/VALIDATION.md). Deployment notes are [DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Online demo

Public address: [art-lovat-two.vercel.app](https://art-lovat-two.vercel.app/). No login.

1. Choose **Complete brief** to load a synthetic request, keep **Demo · synthetic data**, and choose **Start research**. Two concepts with different ways of participating appear.
2. Select a concept. You can lock fields, then propose a change. The change becomes a pending draft. It is written into the confirmed version only after you accept it.
3. Refreshing restores confirmed content and any pending draft. **Export proposal** downloads a Markdown proposal pack.

Projects are isolated by browser. A `?project=` link opens only in the browser that created it. Share the home address. **Live research · model + Qloo** makes real requests, within the per-project request cap.

The agent is instructed to write proposals, questions, and revisions in English.

## Current validation

| Layer | Current conclusion |
| --- | --- |
| Offline run and contracts | `npm test` passed 232 tests. Another 19 Postgres tests passed against an isolated local database. Simulated models, synthetic data, and hand-built proposals are for tests. They do not mean a live model succeeded |
| Public deployment | Offline mode on the public site has produced two concepts, selection, a pending change, acceptance, and restore after refresh. A recorded live-mode acceptance is not in this repository's validation record |
| Live Qloo query | An earlier run returned real descriptions and association recommendations. No concept was accepted in that run, so it is not an end-to-end success |
| Live model proposal | A later isolated project reused saved evidence. Official DeepSeek `deepseek-flash` was rejected twice, then submitted two concepts on the third try, passed the real executor, and showed them on a local page. That round made 0 new Qloo requests |
| Full online research loop and product effect | Not passed. A proposal path that reuses evidence is not a full online research loop, a claim of stable first-try success, or a test of design effect |

Real responses, raw sessions, runtime state, Qloo material that is not cleared for publication, and local screenshots stay on the machine. They are not published with the repository. Cultural fixtures in the public source are marked synthetic.

## Local use

Node.js 22.19 or newer. From the repository root:

```powershell
npm ci
npm start
```

The offline demo needs no model or Qloo key. Open the local address printed at startup, load a synthetic brief that is marked as a demo, answer any question, and compare the two concepts. Offline scenarios can also show a failed query or an irrelevant result.

The default address is [the local workspace](http://127.0.0.1:3000). If dependencies are already installed, `npm start` is enough. The offline model is a deterministic stand-in. It only plays prescribed scenarios. It cannot understand an arbitrary brief and produce a live research concept.

Cultural evidence, design inference, and unverified effects are shown separately. A synthetic fixture is not a Qloo response. Affinity is not an aesthetic score, a sales figure, or a success rate.

```powershell
npm test
```

Tests use synthetic data and a local simulated transport. They do not call a live model or Qloo, do not run a static check, and do not depend on private validation files on this machine. A test may write a local synthetic record. Git ignores that directory. Point `ART_TEST_DATABASE_URL` at an isolated Postgres database to run the database tests as well. Each test uses its own schema and deletes it at the end.

## Runtime boundaries

- Uses the public Node session API of `@qloo/qloo-harness@0.1.26`. The official runtime owns the tool loop.
- The brief, constraints, evidence, concepts, locks, and run state live in the server project record. The chat transcript is not the only source. Local storage is JSON. The Vercel deployment stores projects in Postgres and restores them across function instances.
- The server binds the project id. The model cannot submit one. The executor checks version, evidence ownership, actual fields and values, and literal constraints. Two concepts with no question may omit the question list or send an empty array.
- Live mode needs an explicit provider, model, API protocol, endpoint, and Qloo configuration, plus a separately authorized call budget. One secret environment variable is not a complete configuration.
- Local context budget: live mode with `deepseek-flash`, the `openai-completions` protocol, and the official HTTPS `api.deepseek.com` origin uses **65536 tokens**. Other models, protocols, endpoints, and offline mode stay at **32000**. Model registration, SDK output clamping, and the two local capacity checks share that value. The output cap remains **12000**, with a **4096** safety margin. Bounded context and values already read are kept. 65536 is this app's conservative working budget. The [official model documentation](https://api-docs.deepseek.com/quick_start/pricing/) checked on 2026-10-21 lists a 1M context for that model. This project has not used or verified the full capacity.
- The empty template is [.env.example](.env.example). Live mode is off by default. Keys stay in the local server configuration. They are not written into source, the page, or the repository. The code default is 6 model and 6 Qloo HTTP requests per project, and 12 of each per local server process. On Vercel with a database, a deployment-wide cap applies only when it is set explicitly (see [DEPLOYMENT.md](docs/DEPLOYMENT.md)). The cap includes retries and rejects automatic redirects. One validation run may use a smaller separate cap. The recorded evidence-reuse validation used 3 model requests and 0 Qloo requests. That does not authorize new calls.
- A selected concept can be locked by field. A locked field cannot be changed by a revision proposal and cannot be written on accept. Unlocking is not approval. The board can export a Markdown proposal pack in the browser. It includes confirmed content, pending drafts, version history, and an evidence summary. It does not include raw Qloo responses.
- There is no explicit restore of an older version, no image generation, and no long-term memory. Vercel's Git integration deploys after a push. See `vercel.json`.

## License

Source in this project is under the [MIT License](LICENSE). Third-party dependencies, assets, embedded projects, and Qloo data remain under their own licenses and terms.
