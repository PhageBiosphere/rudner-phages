# Tests

Browser tests for the site. They load `mock-supabase.js` before the page, so the site talks to a stand-in
database of made-up phages and never to the lab's real one.

Run them from this folder (Node.js 18 or later):

```
npm install
npx playwright install chromium
npx playwright test
```

GitHub runs the same tests on every push (see `.github/workflows/tests.yml`); a red cross beside a commit
means a test failed.

| File | What it is |
| --- | --- |
| `site.spec.js` | the tests |
| `mock-supabase.js` | the stand-in database |
| `server.js` | serves the site to the test browser |
