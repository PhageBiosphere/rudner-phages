# Rudner Lab phage data entry

A small website for lab members to add and change phage data. The public, view-only catalogue stays on the Rudner Lab Observable page; this site writes to the same database.

**First version: restriction digests.** For each phage a digest is recorded in three steps that can be done in any order and saved at any point:

1. **Plan** – the virtual digest from the genome sequence: sites and fragments for every enzyme in the catalogue, and whether DNA-modification genes are annotated.
2. **Lab** – the gel image, the lane order, and an optional control digest (lambda by default).
3. **Compare** – lab gel beside the virtual digest in the same lane order, with one click per enzyme.

Sequence first: 1 → 2 → 3. Gel first: 2, save, then 1 and 3 when the sequence arrives.

## Files

| Path | What it is |
| --- | --- |
| `index.html`, `css/app.css` | the page and its styles |
| `js/config.js` | the database address and settings (the only file to change when the database moves) |
| `js/digest.js` | virtual digest and gel drawing |
| `js/app.js` | sign-in, phage list, digest editor |
| `js/vendor/supabase.js` | the Supabase client library (v2.119.2), kept in the repository so the site has no outside dependencies |
| `data/lambda.fasta` | lambda DNA, the default control |

There is no build step: the files are served as they are.

## Publish with GitHub Pages

Repository **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)`**. The site then appears at `https://phagebiosphere.github.io/rudner-phages/`.

## Try it on your own computer

From this folder run `python -m http.server 8000` and open <http://localhost:8000>. (Opening `index.html` by double-click mostly works, but the browser will not load the lambda control from a `file://` page.)

## Images

Gel images are resized in the browser (longer side at most 2000 px, JPEG) and uploaded to the public storage bucket `digest-images`; the database stores the path inside the bucket, not a full address. The optional link to a full-size original (SharePoint / OneDrive) is stored in a column only lab members can read.

## Who can do what

The database enforces this, not the site: students and editors can add and change digests and upload images; only an owner can delete a saved result or an image.
