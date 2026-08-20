# L0 execution card — freeze and tree migration design

Outcome: establish recoverable references, reject legacy-main merge, and assign every active component to keep/port/delete before local implementation.

Gate:
- Cloudflare C7 checkpoint is PASS and branch was clean/pushed.
- C7, old origin/main and old local main have recoverable remote tags.
- local `main` starts from the final Cloudflare product tree.
- no Chat Agent source or second active Task/Worker data plane is accepted.
