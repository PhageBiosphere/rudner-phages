# Phage DNA Modification Analysis (Rudner Lab)

A small website for lab members to record restriction enzyme digests of phage DNA and use them to detect DNA modifications. The public, view-only catalogue stays on the Rudner Lab Observable page; this site writes to the same database.

- **Sequenced and annotated phages**: the lab digest is compared with a virtual digest drawn from the genome sequence, and annotated DNA-modification genes are flagged.
- **Phages without a sequence**: only the restriction enzyme digest is recorded and analysed; the virtual digest and gene check appear once a sequence is available.

**First version: restriction digests.** The first page lists the phages; its columns can be sorted and filtered, and it shows 15, 25, 50 or 100 rows per page. A digest is recorded on one page:

- **Restriction enzymes** (a section that opens and closes): choose the enzymes and put the lanes in gel order, or click a saved **preset** (for example High GC or Low GC) to fill them in at once. Any lab member can save the current lanes as a preset; only an owner can delete one. Presets can also be added, renamed and edited on the **Enzyme details** page, where an owner can add a restriction enzyme to the catalogue. Sites and fragments come from the genome sequence, and annotated DNA-modification genes are flagged.
- **Result for each enzyme**: the chosen lanes in order, each with four buttons: ✓ digests, ~ partial digestion, ✗ does not digest, ? undetermined.
- **Lab digest** on the left (an uploaded image, or the one on PhagesDB) and the **virtual digest** on the right, drawn from the DNA sequence in the same lane order.
- **Gel image, date and control** (a section that opens and closes): upload a gel, record the date and ladder, and add an optional control digest (lambda by default).

The **Analysis** page lists every phage that has results, with one column per enzyme. Enzyme columns are grouped by recognition site (only G/C, only A/T, or both), any column sorts by a click on its heading, and the phage name and headings stay in view while scrolling. **Figure 1** counts, for each host, cluster or subcluster, the phages blocked out of the phages tested with each enzyme. **Figure 2** ranks phages by how many G/C-site and A/T-site enzymes are blocked and labels the likely modification. Both figures sort and filter by column, can follow the table's filters, and download as CSV or an image. Ticked phages can be added to the lab's sequencing queue. Each digest has a **Results checked against the gel** tick-box, and the analysis can count checked digests only. It can be filtered to the phages with a **blocked** enzyme (the gel shows no cut although the genome has sites; with no genome sequence a ✗ is presumed blocked), by how many enzymes are blocked, by whether the phage is sequenced, to one enzyme, or by phage name or cluster. **Show sequencing candidates** lists unsequenced phages with three or more blocked enzymes, and **Recompute virtual digests** fills in the virtual result for every sequenced phage.

Each phage page shows its **digest images** as cards: the picture already on the phage record, then any replicate gels uploaded with **+ Add a digest image**. Every card has an **Add digest result** button (or **Edit digest result** once results exist).

A digest can be saved at any point: with only the enzymes chosen, with only the gel, or with some results still to enter.

## Checking digests

A digest page has **Checked: save and next**, which ticks "Results checked against the gel", saves, and opens the next digest that still needs checking. The arrow keys choose an enzyme and the keys 1 to 4 set its result. Leaving a digest with unsaved changes asks first. Owners can delete a digest. The gel image can be zoomed and dragged.

The phage page puts the name, ID and host on one row, then a summary line (blocked enzymes, likely modification, digests checked), then one card per digest image with that image's results and an Edit button.

The Analysis page also has **Figure 3** (each combination of blocked enzymes and how many phages show it) and a plot in Figure 2. Its filters are remembered in the browser, and **Copy link to this view** gives an address that opens the same view.

Genomes belong in the Rudner Lab database and are added through the sequencing tracker's pipeline import, which keeps each genome's DNA sequence in the private storage bucket `genome-fasta` as `assemblies/<assembly_id>.fasta`. The site reads the phage's selected assembly from there first. As a stopgap, editors can upload a temporary genome DNA sequence from the digest page (`genome-fasta/<phage_id>.fasta`, marked circular or linear in its header); it is used only by this site, ahead of the SharePoint file and PhagesDB, and is not offered once the database's own copy exists. Owners can edit an enzyme's sensitivity notes on the Enzyme details page.

## DNA modification gene islands

**Figure 4** on the Analysis page searches every annotated genome (the lab's annotations and the PhagesDB gene lists) for genes of known DNA modification pathways and groups those within 10 kb of each other into islands. The list of marker enzymes is `MOD_MARKERS` in `js/app.js`, with its sources. Each island is set beside the digest call for the same phage. The phage page's summary names the islands of that phage.

## Long tables

The Phages and Analysis tables list every row in one box that scrolls, with the headings fixed; "Rows shown" sets how tall the box is (10, 20, 40 rows, or as tall as the window). There are no pages. The Phages tab remembers its filters, sort order and box height in the browser (`rudner.phages`), and returns to where it was scrolled when you come back from a phage. "Check next digest" and "Checked: save and next" follow that tab's current order and filters.

## Data quality tab

`#/quality` shows how complete the digest records are, counted from all digests:

1. Phages with a digest (all, sequenced, not sequenced): checked, recorded but not yet checked, none. Click a count to list those phages on the Phages tab.
2. What each digest has: results checked, gel image, control digest, virtual digest.
3. Results by enzyme, with the share that could not be read from the gel.
4. How many enzymes each phage has a result for.
5. Results that disagree with the genome: the gel shows digestion but the genome has no site for the enzyme.

The code is `qualityModel` and `viewQuality` in `js/app.js`.

## Tests

`tests/` holds browser tests that run against a stand-in database (see `tests/README.md`). GitHub runs them on every push.

## Files

| Path | What it is |
| --- | --- |
| `index.html`, `css/app.css` | the page and its styles |
| `js/config.js` | the database address and settings (the only file to change when the database moves) |
| `js/digest.js` | virtual digest and gel drawing |
| `js/app.js` | sign-in, phage list, digest editor |
| `js/vendor/pdf.min.js`, `js/vendor/pdf.worker.min.js` | pdf.js 3.11.174 (Mozilla, Apache-2.0), loaded only when a PDF gel is chosen, to turn its first page into an image |
| `js/vendor/supabase.js` | the Supabase client library (v2.119.2), kept in the repository so the site has no outside dependencies |
| `data/lambda.fasta` | lambda DNA, the default control |

There is no build step: the files are served as they are.

## Publish with GitHub Pages

Repository **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)`**. The site then appears at `https://phagebiosphere.github.io/rudner-phages/`.

## Try it on your own computer

From this folder run `python -m http.server 8000` and open <http://localhost:8000>. (Opening `index.html` by double-click mostly works, but the browser will not load the lambda control from a `file://` page.)

## Images

A gel can be added as a JPEG, PNG or PDF, from the phage page or from the Lab digest panel of a digest; a PDF's first page is turned into an image. Gel images are resized in the browser (longer side at most 2000 px, JPEG) and uploaded to the public storage bucket `digest-images`; the database stores the path inside the bucket, not a full address. The optional link to a full-size original (SharePoint / OneDrive) is stored in a column only lab members can read.

## Who can do what

The database enforces this, not the site: students and editors can add and change digests and upload images; only an owner can delete a saved result or an image.
