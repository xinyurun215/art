# Product agreement: brand pop-up experience design agent

Product direction confirmed: 2026-10-17. Stage status updated: 2026-10-18.

This document is the only source for product position and scope. The direction was confirmed by the user. The formal product name is not decided. The current name only describes the use, and it is not a reason to rename the repository. The capabilities below are **planned scope**. They are not a claim that everything is implemented or that the product has passed validation. Completed local runtime integration, the workspace, feedback and proposal contract fixes, and the boundary of each validation layer are in [stage validation](VALIDATION.md).

This document was first written to set the product agreement. Later implementation, live API calls, commits, pushes, public release, adding a license, and deployment each require explicit authorization in that turn. A later slice is not that authorization. Saving a stage is not full product acceptance.

## 1. Goal and value hypothesis

The product serves experience designers and creative planners on small teams who run brand pop-ups. The core task is to turn a client brief and audience cultural research into an early experience proposal that has a basis, can be discussed, and can be edited.

The main direction has moved from TasteTrip multi-person travel to brand pop-up experience design. The old TasteTrip project stays separate and unchanged. Travel recommendations, fairness algorithms, route planning, and the old pages do not enter this product.

**Value hypothesis, not yet verified:** when the client's opinion changes, cultural evidence can drive a new design choice, keep confirmed content, and leave the reason for the change open to review. A longer proposal, more tool calls, and the convenience of reusing existing code are not product value and are not a reason to widen scope. The user wants to compete for an award. This document does not claim award-winning ability, uniqueness, or an empty market.

## 2. Input and how trustworthy it is

Possible inputs include: brand or product, activity goal, cultural references for the intended audience, city and known venue conditions, budget range, time limits, items that must stay, and items to avoid. There is no required long form. The agent asks only when a gap would change the next decision.

Sources must stay distinct:

- **Facts from the client:** name the person or material. If it has not been checked independently, do not write it as a verified fact.
- **Designer assumptions:** mark the assumption and what it affects.
- **Evidence from an external query:** keep the actual query context, the source, and where it applies.

A few music or film preferences from the user are signals to research. They are not a verified audience profile. If Qloo does not cover the client brand, ask the user to confirm a proxy brand or entity for research. A proxy signal is not the real client profile.

## 3. V1 proposal board and deliverables

The core artifact is a project proposal board that stays current and can be edited. It includes:

1. Confirmed requirements, limits, and open questions.
2. Qloo evidence cards with the query context.
3. **Two substantively different concepts.** The difference is how people participate or how they meet the product, not the name, tone, or copy. Each concept says why someone comes, what they do inside, how they meet the product, and what they take away.
4. The selected proposal, locked parts, pending changes, and version history.
5. Unknowns, and a proposal pack that can be exported.

Sketches can be an optional aid later. They are not required for the first version to stand. These are early experience proposals, not construction documents. They do not guarantee engineering budget, venue safety, or event results.

## 4. Qloo evidence and how it may be used

Use confirmed cultural entities and a geographic filter when it applies. Follow the official workflow for the queries that are actually needed. The result must affect concept exploration or the choice. Do not walk every endpoint just to show tools. The official kit says `@qloo/qloo-harness` shares a workflow across explore, the CLI, and MCP. That only proves what the documentation says. It does not prove the whole product runtime is compatible. [Official kit](https://github.com/qloo/qloo-hackathon-kit)

An evidence card keeps at least the following. Use fields that were actually returned. Mark missing items unknown. Do not invent API fields.

| Content | Minimum |
| --- | --- |
| Query context | The design question; id, type, and name of each confirmed entity; whether it is a proxy, and the confirmation record |
| Place and execution | City or geographic range, whether the filter applies, the official workflow and its input, a safe request reference, and the query time |
| Actual result | Ids of returned entities, fields actually returned, source, and evidence references |
| Design link | Which design choice it supports or changes, how it was translated, and what evidence is still missing |

A safe request reference must be enough to trace the needed context. It must not contain secrets or unrelated personal data. Keeping, showing, and exporting raw data follows the applicable data terms. A full response is not kept or published by default. [Safe use](https://github.com/qloo/qloo-hackathon-kit/blob/main/docs/SAFE_USE.md)

Each important claim is split:

- **Data fact:** the actual input entities, returned fields, and source.
- **Design inference:** why those cultural associations were translated into an experience mechanism.
- **Unverified effect:** appeal, participation, conversion, and other results that still need a separate check.

Do not treat affinity as an aesthetic score, a proposal-quality score, a probability that a design fits, or an effect prediction. Popularity cannot stand in for affinity. Do not assume scores from different requests can be compared directly. An aggregated cultural association does not prove an individual's behavior or a causal effect. [Safe use](https://github.com/qloo/qloo-hackathon-kit/blob/main/docs/SAFE_USE.md)

Cultural data also does not prove color, material, circulation, rights clearance, a real quote, or that a partner is available. When support is missing, write "not enough evidence" or "unknown". Do not force evidence onto every concept. Start from the smallest query that is needed, limit retries and budget, avoid unrelated personal data, and protect secrets. [Access and quota](https://github.com/qloo/qloo-hackathon-kit/blob/main/docs/API_ACCESS.md)

## 5. How the agent works

Inside the task and resource limits, the agent decides what to clarify next, what to query, what to compare, whether to change the first idea, whether to propose, or whether to pause. Tool results go back to the model and inform the next decision. This is not a fixed pipeline that calls the model once at the end to polish copy. A turn also does not have to repeat "clarify, query, propose" or demonstrate tools.

Code checks input, tool permission, resource caps, project isolation, version consistency, locked content, and approval rules. The user confirms important ambiguity, tradeoffs, a change of direction, and a formal edit. The interface shows a short reason for the action, the tool record, and evidence that can be checked. It does not ask for or show the model's private reasoning.

## 6. Project state, locks, and edits

The authority is the project record, not the chat transcript. It keeps at least the brief, confirmed entities, constraints, evidence references, proposals, the selected version, locks, pending changes, and version history.

The model proposes a limited change only through a constrained tool. It cannot overwrite the whole project. A change carries the project and base version. Stale versions and writes into another project are rejected.

1. The user can lock confirmed content. The model cannot unlock it.
2. When a request touches a locked item, show the effect and let the user decide whether to unlock. **Unlocking is not approval of the change.**
3. The model proposes a pending difference, its basis, and unknowns. Until the user approves, the confirmed version stays as it is.
4. If the user rejects a pending change, the confirmed version stays. Restoring an older confirmed version must be an explicit action and must leave a history.
5. Refreshing or restoring the current project brings back confirmed content and pending content as separate things.

Slice one considers the data shape for this state. Full save, restore, and refresh acceptance belong to slice three. Do not build a heavy platform early. V1 does not include a vector database, cross-client profiles, long-running automatic preference learning, or multi-person live collaboration.

## 7. Reusing official capability and choosing a runtime

Build on the official `@qloo/qloo-harness`. Do not rewrite the transport, MCP, or a general agent kernel. **First check whether the official full agent runtime** can support custom product tools, calls from the web, session restore, and deployment. If it is enough, reuse it. Consider a mature tool-calling framework plus the official Qloo executor only with concrete evidence that an interface or the runtime is incompatible. An interface existing is not full compatibility. Do not decide the runtime, model provider, database, dependency versions, or a fallback path before that evidence.

Official docs checked read-only: explore mode in agent-chat can read, search, list projects, and call Qloo workflows. It cannot run a shell or edit project files. It can save its own private state. Integrate, plan, and build modes are outside what this contest supports. That is **what the docs claim**. It does not prove the full runtime is compatible, or that it cannot be. [Official agent example](https://github.com/qloo/qloo-hackathon-kit/blob/main/starter/agent-chat/README.md)

**Historical evidence from the user, not rechecked this round:** the official Node.js executor `0.1.26` once succeeded on a real call locally and on a protected Vercel Preview. That does not prove a full design agent can be deployed, and it is not a reason to lock a version for this round. The contest endpoint and the default endpoint differ. Later work must check the endpoint explicitly. Silent fallback is not allowed.

Secrets are used only on the server. They do not go into docs, logs, the frontend, or the repository. This round does not add dependencies or pin new versions.

## 8. Workspace and interface

One workspace shows the brief and proposal board, the agent conversation, and the activity record at the same time. The current artifact stays visible. The user can check evidence, compare concepts, lock content, and review a change. The product does not collapse into a chat transcript.

Visual style is not decided. Do not reuse TasteTrip ink-wash or travel decoration. This round does not design or build the interface.

## 9. Explicitly out of scope

- A travel product, a general orchestration platform, a multi-agent division-of-labor framework, and a full brand-consulting service.
- CAD or construction drawings, contacting suppliers automatically, purchasing, booking, and payment.
- A guarantee of rights, invented quotes, a guarantee that a partner is available, and a prediction of event results.
- Unrelated algorithms, pages, or old-project features brought in because they are easy to reuse.

## 10. Later slices and the order of acceptance

The following is a **future implementation order**. It is not authorization to implement this round or to call a live API.

| Slice | Scope | Done when |
| --- | --- | --- |
| 1 | Brief to official live Qloo evidence to two reviewable concepts; consider the state shape that is needed | A key design choice can be traced to an actual response. When evidence is thin, the research changes, a question is asked, or the gap is reported. Nothing is invented |
| 2 | Choose a proposal, lock parts, give feedback, make a limited edit, review and approve | Affected parts update. Locked content stays. The confirmed version does not change before approval |
| 3 | Reliable save, restore, export, public deployment, and acceptance with new input that is not a preset | Refresh restores confirmed and pending state correctly. An input that is not a fixed sample completes the flow, and export and the real deployment behavior are checked |

Each slice records the evidence it actually produced. Writing code, passing a local check, a successful live API call, a usable interface, public deployment, and a verified product effect are different conclusions. One does not stand in for another.

## 11. Synthetic acceptance case

This is a pop-up task for a fictional sneaker brand. It constrains behavior. It is not a real client, a real Qloo query, or evidence of effect. The audience gives music and film references only as unverified research signals. The client requires that try-on stay.

Two provisional mechanisms, as examples:

- A scheduled group try-on led by music, with a live performance.
- A self-paced film-narrative exploration that moves forward through try-on challenges.

They only show that mechanisms can differ. They do not claim cultural data already supports them. A real concept still depends on the actual query and the limits.

The user picks the first, locks try-on, then asks to drop the live performance and keep the music culture. The expected edit must actually redo the affected participation: why people arrive, how time is organized, what happens on site, how they meet the product, and what they take away. The locked try-on stays whole. A self-paced activity or a movement task might replace waiting for a stage, but that is a design inference that still needs evidence and a rights check. It is not a wording swap and it is not a guarantee.

The system shows the pending difference, the basis, and the unknowns. The confirmed version does not change before approval. After a rejection, the confirmed version stays. An explicit restore keeps history. After refresh, confirmed and pending state stay distinct. This case does not use invented Qloo entities or numbers, and it does not replace the live evidence acceptance in slice one.

## 12. Contest rules and nearby work, as evidence

As checked read-only on 2026-10-17, the contest submission notes require: an app that runs end to end, hosted publicly, a public source repository, a written explanation, and a visible open-source license. A demo video is not required. Three minutes can be an internal demo target. It is not a formal video rule. These future delivery requirements do not authorize publishing repository content, adding a license, or deploying in this round. [Contest requirements](https://qloo.devpost.com/); [official submission guide](https://github.com/qloo/qloo-hackathon-kit/blob/main/docs/SUBMISSION.md)

The notes below only looked at public introduction pages. The apps were not tested and the source was not audited. The text is the authors' own description, not independently verified, and the set of nearby work is incomplete.

| Nearby work | Public description and how it sits next to this project |
| --- | --- |
| [CultOS](https://devpost.com/software/cultos-autonomous-cultural-intelligence-engine) | The author describes live-music sponsorship and cultural activation, a nearby scene for brand cultural experiences |
| [FanFit](https://github.com/brainupgrade-in/fanfit) | The README describes sponsor partners and evidence cards from Qloo affinity, nearby to evidence-based planning |
| [GMM](https://devpost.com/software/gmm-tasteengine-cultural-graph-multi-agent-art-director) | The author describes a cultural graph, multi-agent art direction, and 2D/3D assets, nearby to cultural research that becomes creative output |

Those relationships are inferences from public descriptions. They do not prove this project is different, and they do not prove the market lacks similar products. Unverified claims of accuracy, price, or uniqueness are not accepted.

## 13. Still to verify and still to decide

- Target designers have not been interviewed. The value of the real brief and the edit flow is not verified.
- Qloo's coverage and design value for brand pop-ups are not verified.
- The official runtime has been wired locally, and tool execution and the proposal path have been checked. Deployment, restore across processes, and compatibility with the full V1 are not verified.
- Direct competitor research is incomplete.
- The formal name, the product's runtime model and provider, storage, and visual style are not decided.

These unknowns do not by themselves change direction. When a problem shows up, report the effect and the smallest fix. A change of direction or scope waits for the user.

The assistant used for development is separate from the product's runtime model. The assistant does not decide the product's model or provider. Using a model once for a check does not set the final product configuration.
