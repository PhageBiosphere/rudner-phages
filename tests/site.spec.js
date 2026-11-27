// Browser tests for the Phage DNA Modification Analysis site.
// Every test loads tests/mock-supabase.js first, so the site talks to a stand-in database with made-up phages.
const { test, expect } = require("@playwright/test");
const path = require("path");

async function open(page, hash, role) {
  if (role) await page.addInitScript((r) => { window.__TEST_ROLE__ = r; }, role);
  await page.addInitScript(() => { try { localStorage.clear(); } catch (e) { /* first visit */ } });
  await page.addInitScript({ path: path.join(__dirname, "mock-supabase.js") });
  await page.goto("/index.html" + hash);
}
const db = (page, expr) => page.evaluate(`(() => { const D = window.__DB__; return ${expr}; })()`);
const cells = async (loc) => (await loc.allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());

test.describe("virtual digest arithmetic", () => {
  test("counts sites and fragment sizes, linear and circular, with ambiguity codes", async ({ page }) => {
    await open(page, "#/");
    const r = await page.evaluate(() => {
      const DG = window.Digest, seq = "AAAA" + "GGATCC" + "TTTTTTTTTT" + "GGATCC" + "CCCC";   // BamHI sites at 4 and 20; 30 bases
      return { lin: DG.digest(seq, "GGATCC", false), circ: DG.digest(seq, "GGATCC", true), none: DG.digest(seq, "GAATTC", false), iupac: DG.digest("TTACATGTAA", "RCATGY", false) };
    });
    expect(r.lin).toEqual({ sites: 2, fragments: [16, 10, 4] });
    expect(r.circ.sites).toBe(2);
    expect(r.circ.fragments.reduce((a, b) => a + b, 0)).toBe(30);
    expect(r.none).toEqual({ sites: 0, fragments: [30] });
    expect(r.iupac.sites).toBe(1);
  });
});

test.describe("Phages tab", () => {
  test("lists phages and filters to those that need checking", async ({ page }) => {
    await open(page, "#/");
    await expect(page.locator("table.list tbody tr")).toHaveCount(12);
    await page.selectOption('select[data-lf="digest"]', "tocheck");
    await expect(page.locator("table.list tbody tr")).toHaveCount(10);   // 11 phages have a digest, one of them is checked
    await page.selectOption('select[data-lf="digest"]', "checked");
    await expect(page.locator("table.list tbody tr")).toHaveCount(1);
    await page.selectOption('select[data-lf="digest"]', "no");
    await expect(page.locator("table.list tbody tr")).toHaveCount(1);
  });
  test("filters to phages with no digest image", async ({ page }) => {
    await open(page, "#/");
    await page.selectOption('select[data-lf="image"]', "yes");
    await expect(page.locator("table.list tbody tr")).toHaveCount(1);          // only Phage07 has a picture in the stand-in data
    await expect(page.locator("table.list tbody tr")).toContainText("Phage07");
    await page.selectOption('select[data-lf="image"]', "no");
    await expect(page.locator("table.list tbody tr")).toHaveCount(11);
    await expect(page.locator("table.list tbody tr").first()).toContainText("no image");
  });
  test("the menu bar highlights the open page", async ({ page }) => {
    await open(page, "#/analysis");
    await expect(page.locator("header nav a.on")).toHaveText("Analysis");
    await page.click('header nav a[href="#/enzymes"]');
    await expect(page.locator("header nav a.on")).toHaveText("Enzyme details");
  });
});

test.describe("Phage page", () => {
  test("shows the name, ID and host on one row, the add-image button, a summary, and results inside the image card", async ({ page }) => {
    await open(page, "#/phage/p01");
    const head = page.locator(".phead");
    await expect(head).toContainText("Phage01");
    await expect(head).toContainText("ID 000002");
    await expect(head).toContainText("Mycobacterium smegmatis mc2155");
    await expect(page.locator("label.btn", { hasText: "Add a digest image" })).toBeVisible();
    await expect(page.locator(".psum")).toContainText("Likely modified");
    await expect(page.locator(".psum")).toContainText("G/C");
    const card = page.locator(".imgbox").first();
    await expect(card).toContainText("Digest image 1");
    await expect(card.locator("table.dres tbody tr td").first().locator("a.btn")).toHaveText("Edit");
    await card.locator("table.dres a.btn").click();
    await expect(page).toHaveURL(/#\/phage\/p01\/digest\/xp01$/);
  });
  test("a phage with no digest offers Add digest result", async ({ page }) => {
    await open(page, "#/phage/p11");
    await expect(page.locator(".imgbox a.btn.primary")).toHaveText("Add digest result");
  });
});

test.describe("Digest page", () => {
  test("keyboard sets results, arrows move an enzyme, and saving keeps the control name", async ({ page }) => {
    await open(page, "#/phage/p08/digest/xp08");
    await page.waitForSelector("table.results");
    await page.keyboard.press("3");                       // first enzyme: does not digest
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("2");                       // third enzyme: partial
    await page.locator("table.results thead th").nth(1).locator('[data-dir="1"]').click();   // move the first enzyme one place right
    await page.check("[data-chk]");
    await page.click('[data-act="save"]');
    await expect(page.locator(".savebar .msg")).toContainText("Saved");
    const x = await db(page, `D.restriction_digest_experiments.find((e) => e.restriction_digest_experiment_id === "xp08")`);
    expect(x.lane_layout.slice(0, 4)).toEqual(["L", "U", "e1", "e0"]);
    expect(x.control_name).toBe("Lambda DNA");
    expect(x.results_checked).toBe(true);
    expect(x.no_control).toBe(true);
    const rs = await db(page, `Object.fromEntries(D.restriction_digest_results.filter((r) => r.restriction_digest_experiment_id === "xp08").map((r) => [r.restriction_enzyme_id, [r.observed_result, r.lane_number]]))`);
    expect(rs.e0).toEqual(["No digestion", 4]);
    expect(rs.e1).toEqual(["Digestion", 3]);
    expect(rs.e2[0]).toBe("Partial digestion");
  });
  test("Checked: save and next opens the next digest that needs checking", async ({ page }) => {
    await open(page, "#/phage/p01/digest/xp01");
    await page.waitForSelector(".savebar");
    await expect(page.locator("h2 .prog")).toContainText("1 of 11 digests checked");
    await page.click('[data-act="savenext"]');
    await expect(page).toHaveURL(/#\/phage\/p10\/digest\/xp10$/);   // the list starts with the newest lab ID: after p01 comes p00 (already checked), then round to p10
    await expect(page.locator("h2 .prog")).toContainText("2 of 11 digests checked");
    expect(await db(page, `D.restriction_digest_experiments.find((e) => e.restriction_digest_experiment_id === "xp01").results_checked`)).toBe(true);
  });
  test("warns before leaving with unsaved changes, and stays when the user cancels", async ({ page }) => {
    await open(page, "#/phage/p08/digest/xp08");
    await page.waitForSelector("table.results");
    await page.keyboard.press("3");
    let asked = 0;
    page.once("dialog", (d) => { asked += 1; d.dismiss(); });
    await page.click('header nav a[href="#/analysis"]');
    await expect(page).toHaveURL(/digest\/xp08$/);
    expect(asked).toBe(1);
    await expect(page.locator("table.results button.call.on.bad")).toHaveCount(1);   // the unsaved result is still there
    page.once("dialog", (d) => d.accept().catch(() => {}));
    await page.click('header nav a[href="#/analysis"]');
    await expect(page).toHaveURL(/#\/analysis$/);
    await page.waitForSelector("table.main");
  });
  test("Cancel leaves the digest without saving and without asking", async ({ page }) => {
    await open(page, "#/phage/p08/digest/xp08");
    await page.waitForSelector("table.results");
    await page.keyboard.press("3");
    let asked = 0;
    page.on("dialog", (d) => { asked += 1; d.dismiss().catch(() => {}); });
    await page.click('[data-act="cancel"]');
    await expect(page).toHaveURL(/#\/phage\/p08$/);
    await expect(page.locator(".phead")).toContainText("Phage08");
    expect(asked).toBe(0);
    expect(await db(page, `D.restriction_digest_results.find((r) => r.restriction_digest_experiment_id === "xp08" && r.restriction_enzyme_id === "e0").observed_result`)).toBe("Digestion");
  });
  test("an owner can delete a digest; other roles are not offered the button", async ({ page, browser }) => {
    await open(page, "#/phage/p09/digest/xp09");
    await page.click('[data-act="del"]');
    await page.click('[data-act="delyes"]');
    await expect(page).toHaveURL(/#\/phage\/p09$/);
    expect(await db(page, `D.restriction_digest_experiments.some((e) => e.restriction_digest_experiment_id === "xp09") || D.restriction_digest_results.some((r) => r.restriction_digest_experiment_id === "xp09")`)).toBe(false);
    const other = await browser.newPage();
    await open(other, "#/phage/p08/digest/xp08", "student");
    await other.waitForSelector(".savebar");
    await expect(other.locator('[data-act="del"]')).toHaveCount(0);
    await other.close();
  });
  test("a preset fills in the lanes", async ({ page }) => {
    await open(page, "#/phage/p11/digest/new");
    await page.click("[data-preset]");
    await expect(page.locator('details[data-sec="enz"] summary')).toContainText("Ladder, Uncut, BamHI, SalI, KpnI");
  });
  test("an uploaded genome FASTA is used for the virtual digest", async ({ page }) => {
    await open(page, "#/phage/p08/digest/xp08");
    await page.waitForSelector("table.results");
    await expect(page.locator(".note.warn")).toContainText("No virtual digest yet");
    const fasta = ">test genome\n" + "ACGT".repeat(300) + "GGATCC" + "ACGT".repeat(300) + "\n";
    await page.setInputFiles("[data-genomeup]", { name: "p08.fasta", mimeType: "text/plain", buffer: Buffer.from(fasta) });
    await expect(page.locator(".card > p.sub").first()).toContainText("Temporary genome uploaded on this site");
    await expect(page.locator("table.results tbody tr").nth(1).locator("td").first()).toContainText("1 cut");   // BamHI
    expect(await page.evaluate(() => [...window.__FILES__.keys()])).toEqual(["genome-fasta/p08.fasta"]);
  });
  test("a lab digest image can be added from the Lab digest panel, as a picture or as a PDF", async ({ page }) => {
    await open(page, "#/phage/p08/digest/xp08");
    await page.waitForSelector("table.results");
    await expect(page.locator("#gels label.btn", { hasText: "Add a lab digest image" })).toBeVisible();
    await page.setInputFiles('#gels [data-upload="gel"]', path.join(__dirname, "fixtures", "gel.png"));
    await expect(page.locator(".savebar .msg")).toContainText("Image uploaded (600 × 400");
    await expect(page.locator("#gels label.btn", { hasText: "Replace image" })).toBeVisible();
    await page.setInputFiles('#gels [data-upload="gel"]', path.join(__dirname, "fixtures", "gel-two-pages.pdf"));
    await expect(page.locator(".savebar .msg")).toContainText("Page 1 of the PDF's 2 pages was used");
    const up = await page.evaluate(() => [...window.__FILES__.keys()]);
    expect(up.length).toBe(2);
    expect(up.every((k) => /^digest-images\/p08\/xp08\/gel-\d+\.jpg$/.test(k))).toBe(true);
    await page.click('[data-act="save"]');
    await expect(page.locator(".savebar .msg")).toContainText("Saved");
    expect(await db(page, `D.restriction_digest_experiments.find((e) => e.restriction_digest_experiment_id === "xp08").gel_image_path`)).toMatch(/^p08\/xp08\/gel-\d+\.jpg$/);
  });
  test("a PDF can be added as a replicate image from the phage page", async ({ page }) => {
    await open(page, "#/phage/p08");
    await page.setInputFiles("[data-replicate]", path.join(__dirname, "fixtures", "gel-two-pages.pdf"));
    await expect(page.locator(".imgbox")).toHaveCount(2);
    await expect(page.locator(".msg").first()).toContainText("Digest image added. Page 1 of the PDF");
  });
  test("the gel image zooms in and resets", async ({ page }) => {
    await open(page, "#/phage/p07/digest/xp07");      // Phage07 has a gel picture in the stand-in data
    await page.waitForSelector(".zoomwrap img");
    await page.click('[data-zoom="1"]');
    await expect(page.locator(".zoomwrap img")).toHaveAttribute("style", /scale\(1\.5\)/);
    await page.click('[data-zoom="0"]');
    await expect(page.locator(".zoomwrap img")).toHaveAttribute("style", /scale\(1\)/);
  });
});

test.describe("Analysis tab", () => {
  test("groups enzymes by site, sorts by a column, and remembers nothing between tests", async ({ page }) => {
    await open(page, "#/analysis");
    await page.waitForSelector("table.main");
    expect(await cells(page.locator("table.main tr.r1 th.grp"))).toEqual(["G/C sites only", "A/T sites only", "G/C and A/T in the site"]);
    expect((await cells(page.locator("table.main tr.r2 th"))).map((t) => t.split(" ")[0])).toEqual(["BstUI", "HaeIII", "SacII", "SmaI", "DraI", "MseI", "BamHI", "EcoRI", "KpnI", "NspI", "SalI"]);
    await expect(page.locator("table.main tbody tr")).toHaveCount(11);
    await page.click('table.main th[data-asort="main:blocked"]');
    await expect(page.locator("table.main tbody tr").first().locator("td.nm")).toContainText("Phage06");   // 6 blocked
    await page.selectOption('[data-an="host"]', "Mycobacterium smegmatis mc2155");
    await expect(page.locator("table.main tbody tr")).toHaveCount(4);
  });
  test("Figure 2 labels the likely modification and marks weak A/T calls", async ({ page }) => {
    await open(page, "#/analysis");
    await page.waitForSelector("table.fig2");
    await page.selectOption('[data-an="f2.f.call"]', "G/C");
    expect((await cells(page.locator("table.fig2 tbody tr td:first-child"))).sort()).toEqual(["Phage00", "Phage01", "Phage02", "Phage03"]);
    await page.selectOption('[data-an="f2.f.call"]', "A/T");
    const rows = await cells(page.locator("table.fig2 tbody tr"));
    expect(rows.length).toBe(2);
    expect(rows.find((r) => r.startsWith("Phage04"))).toContain("Genome-checked");
    expect(rows.find((r) => r.startsWith("Phage05"))).toContain("Weak: A/T sites unconfirmed");
    await page.selectOption('[data-an="f2.f.call"]', "G/C and A/T");
    expect(await cells(page.locator("table.fig2 tbody tr td:first-child"))).toEqual(["Phage06"]);
    await page.selectOption('[data-an="f2.f.call"]', "");
    await expect(page.locator("#gcat circle[fill-opacity]")).toHaveCount(11);   // every phage with results was tested with both kinds of enzyme
  });
  test("Figure 3 counts each pattern of blocked enzymes", async ({ page }) => {
    await open(page, "#/analysis");
    await page.waitForSelector("table.fig3");
    const rows = await cells(page.locator("table.fig3 tbody tr"));
    expect(rows.length).toBe(3);
    expect(rows[0]).toMatch(/^BstUI \+ HaeIII \+ SacII \+ SmaI 4 4 G\/C 4 /);
    await page.fill('[data-ain="f3.f.q"]', "DraI");
    await expect(page.locator("table.fig3 tbody tr")).toHaveCount(2);
  });
  test("Figure 4 finds modification gene islands and sets them beside the digest call", async ({ page }) => {
    await open(page, "#/analysis");
    await page.waitForSelector("table.fig4");
    await expect(page.locator('details[data-sec="fig4"] summary')).toContainText("5 of 5 found in 4 of 4 annotated genomes");
    const row = (name) => page.locator("table.fig4 tbody tr", { hasText: name });
    await expect(row("Phage00")).toContainText("Island");
    await expect(row("Phage00")).toContainText("Strong");
    await expect(row("Phage00")).toContainText("5,000–8,000");
    await expect(row("Phage00")).toContainText("DpdA / tRNA-guanine transglycosylase homologue (gene 7); QueC (gene 9); amidotransferase (Gat / ArcS) (gene 10)");
    await expect(row("Phage00")).toContainText("✓ agrees");
    await expect(row("Phage00").locator("svg.imap rect")).toHaveCount(4);          // three marker genes and the hypothetical gene between them
    await expect(row("Phage02")).toContainText("Supporting genes only");
    await expect(row("Phage02")).toContainText("not stated");                      // supporting genes alone predict no base
    await expect(row("Phage04")).toContainText("Single gene");
    await expect(row("Phage08")).toHaveCount(2);                                   // two core genes 28 kb apart are not one island
    await expect(row("Phage08").first()).toContainText("differs");
    await page.selectOption('[data-an="f4.f.kind"]', "Island");
    await expect(page.locator("table.fig4 tbody tr")).toHaveCount(2);
    await page.selectOption('[data-an="f4.f.kind"]', "");
    await page.fill('[data-ain="f4.f.gene"]', "methyl");
    await expect(page.locator("table.fig4 tbody tr")).toHaveCount(2);              // the DNA methyltransferase and the dCMP hydroxymethylase
  });
  test("the phage page summary names the phage's modification gene islands", async ({ page }) => {
    await open(page, "#/phage/p00");
    await expect(page.locator(".psum")).toContainText("island at 5,000–8,000 bp");
    await expect(page.locator(".psum")).toContainText("predicted G/C");
  });
  test("the view is remembered, can be cleared, and can be opened from a copied address", async ({ page, context }) => {
    await open(page, "#/analysis");
    await page.waitForSelector("table.main");
    await page.selectOption('[data-an="min"]', "3");
    await expect(page.locator("table.main tbody tr")).toHaveCount(5);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("rudner.analysis")).min);
    expect(saved).toBe("3");
    const link = await page.evaluate(() => { const s = JSON.parse(localStorage.getItem("rudner.analysis")); return "#/analysis?v=" + encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(s))))); });
    await page.click('[data-act="anreset"]');
    await expect(page.locator("table.main tbody tr")).toHaveCount(11);
    const p2 = await context.newPage();
    await open(p2, link);
    await p2.waitForSelector("table.main");
    await expect(p2.locator("table.main tbody tr")).toHaveCount(5);
  });
  test("ticked phages are added to the sequencing queue after a yes", async ({ page }) => {
    await open(page, "#/analysis");
    await page.waitForSelector("table.main");
    await page.locator("table.main tbody tr").nth(1).locator("[data-asel]").check();
    await expect(page).toHaveURL(/#\/analysis$/);          // ticking does not open the phage
    await page.click('[data-act="queue"]');
    await page.click('[data-act="queueyes"]');
    await expect(page.locator(".anbar .msg").first()).toContainText("1 phage added to the sequencing queue");
    const rpc = await page.evaluate(() => window.__RPC__);
    expect(rpc[0][0]).toBe("queue_sequencing");
    expect(rpc[0][1].p_phage_ids).toEqual(["p01"]);
  });
  test("the table downloads as CSV", async ({ page }) => {
    await open(page, "#/analysis");
    await page.waitForSelector("table.main");
    const [d] = await Promise.all([page.waitForEvent("download"), page.click('[data-adl="main.csv"]')]);
    expect(d.suggestedFilename()).toMatch(/^phage_digest_analysis_\d{4}-\d{2}-\d{2}\.csv$/);
  });
});

test.describe("Enzyme details", () => {
  test("an owner edits an enzyme's sensitivity note, and it appears in the phage summary", async ({ page }) => {
    await open(page, "#/enzymes");
    const row = page.locator("table.list tbody tr", { hasText: "SacII" }).last();
    await row.locator('[data-ze="edit"]').click();
    await page.fill('[data-zef="sens"]', "blocked by cytosine methylation");
    await page.click('[data-ze="save"]');
    expect(await db(page, `D.restriction_enzymes.find((z) => z.enzyme_name === "SacII").modification_sensitivity`)).toBe("blocked by cytosine methylation");
    await page.evaluate(() => { location.hash = "#/phage/p01"; });
    await expect(page.locator(".psum")).toContainText("SacII: blocked by cytosine methylation");
  });
});

test.describe("Data quality tab", () => {
  test("counts phages with a digest and how many are checked, for all, sequenced and unsequenced phages", async ({ page }) => {
    await open(page, "#/quality");
    await expect(page.locator("h2")).toHaveText("Data quality");
    const want = await db(page, `(() => { const ex = D.restriction_digest_experiments, by = {}; for (const x of ex) (by[x.phage_id] = by[x.phage_id] || []).push(x);
      const count = (keep) => { const o = { n: 0, checked: 0, todo: 0, none: 0 }; for (const p of D.phage_catalog_public) { if (!keep(p)) continue; o.n++; const d = by[p.phage_id] || []; if (!d.length) o.none++; else if (d.every((x) => x.results_checked)) o.checked++; else o.todo++; } return o; };
      return [count(() => true), count((p) => !!p.genome_length_bp), count((p) => !p.genome_length_bp)]; })()`);
    expect(want[0]).toEqual({ n: 12, checked: 1, todo: 10, none: 1 });
    const rows = page.locator('details[data-sec="q1"] .qrow');
    await expect(rows).toHaveCount(3);
    for (let i = 0; i < 3; i++) {
      const text = (await rows.nth(i).innerText()).replace(/\s+/g, " ");
      expect(text).toContain(`${want[i].n} phages`);
      expect(text).toContain(`Checked ${want[i].checked} `);
      expect(text).toContain(`not yet checked ${want[i].todo} `);
      expect(text).toContain(`No digest ${want[i].none} `);
    }
    expect(want[1].n + want[2].n).toBe(12);
    await expect(page.locator("header nav a.on")).toHaveText("Data quality");
    for (const k of ["q2", "q3", "q4", "q5"]) await expect(page.locator(`details[data-sec="${k}"]`)).toBeVisible();
    const nres = await db(page, "D.restriction_digest_results.filter((r) => r.observed_result).length");
    await expect(page.locator('details[data-sec="q3"] summary')).toContainText(`${nres} results`);
    const perEnzyme = await cells(page.locator('details[data-sec="q3"] tbody tr td:nth-child(2)'));
    expect(perEnzyme.reduce((a, b) => a + Number(b), 0)).toBe(nres);
  });

  test("a count opens the Phages tab showing those phages", async ({ page }) => {
    await open(page, "#/quality");
    await page.locator('details[data-sec="q1"] .qrow').first().locator("a", { hasText: "not yet checked" }).click();
    await expect(page.locator("table.list tbody tr")).toHaveCount(10);
    await expect(page.locator('select[data-lf="digest"]')).toHaveValue("tocheck");
  });
});

test.describe("Scrolling tables", () => {
  test("the Phages tab lists every phage in a box fifteen rows tall by default, with no page buttons", async ({ page }) => {
    await open(page, "#/");
    await expect(page.locator("table.list tbody tr")).toHaveCount(12);
    await expect(page.locator("button[data-page]")).toHaveCount(0);
    await expect(page.locator(".pager")).toContainText("12 of 12 phages");
    const m = () => page.evaluate(() => { const b = document.querySelector(".listbox"), t = b.querySelector("table"); return { box: b.clientHeight, head: t.tHead.offsetHeight, row: t.tBodies[0].rows[0].offsetHeight, scrolls: b.scrollHeight > b.clientHeight + 4, top: getComputedStyle(t.tHead.rows[0].cells[0]).position }; });
    await expect(page.locator("select[data-lrows]")).toHaveValue("15");
    let x = await m();
    expect(x.scrolls).toBe(false);                      // twelve phages fit in fifteen rows
    expect(x.top).toBe("sticky");
    await page.selectOption("select[data-lrows]", "10");
    x = await m();
    expect(Math.abs(x.box - (x.head + 10 * x.row))).toBeLessThan(6);
    expect(x.scrolls).toBe(true);
    await page.selectOption("select[data-lrows]", "20");
    x = await m();
    expect(x.scrolls).toBe(false);                      // twelve phages fit in twenty rows
    await page.selectOption("select[data-lrows]", "fit");
    await expect(page.locator(".listbox")).toBeVisible();
  });

  test("one search box finds a phage by name, lab ID, host or cluster", async ({ page }) => {
    await open(page, "#/");
    const p = await db(page, "D.phage_catalog_public[5]");
    await page.fill('input[data-lf="q"]', p.phage_name.toUpperCase());
    await expect(page.locator("table.list tbody tr")).toHaveCount(1);
    await expect(page.locator('input[data-lf="q"]')).toBeFocused();
    await page.fill('input[data-lf="q"]', "AZ1");                                    // a subcluster
    const n = await db(page, "D.phage_catalog_public.filter((x) => x.phagesdb_subcluster === 'AZ1').length");
    await expect(page.locator("table.list tbody tr")).toHaveCount(n);
    await page.click('[data-act="clearfilters"]');
    await expect(page.locator("table.list tbody tr")).toHaveCount(12);
  });

  test("filters, sort order and scroll position are kept when coming back from a phage", async ({ page }) => {
    await open(page, "#/");
    await page.selectOption("select[data-lrows]", "10");       // twelve phages, two more than the box then shows
    await page.locator("th[data-sort]").first().click();
    const order = await cells(page.locator("table.list tbody tr td:first-child"));
    await page.evaluate(() => { const b = document.querySelector(".listbox"); b.scrollTop = 40; b.dispatchEvent(new Event("scroll")); });
    expect(await page.evaluate(() => document.querySelector(".listbox").scrollTop)).toBe(40);
    await page.locator("table.list tbody tr").nth(5).locator("td").nth(2).click();
    await expect(page.locator(".phead")).toBeVisible();
    await page.goBack();
    await expect(page.locator("table.list tbody tr")).toHaveCount(12);
    expect(await cells(page.locator("table.list tbody tr td:first-child"))).toEqual(order);
    expect(await page.evaluate(() => document.querySelector(".listbox").scrollTop)).toBe(40);
    // the filters and sort order are also remembered in the browser for the next visit
    await page.selectOption('select[data-lf="digest"]', "tocheck");
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("rudner.phages2")));
    expect(saved.filters.digest).toBe("tocheck");
    expect(saved.sort).toEqual({ k: "name", dir: 1 });
    expect(saved.rows).toBe("10");
    await page.evaluate(() => localStorage.clear());
  });

  test("Check next digest opens the first one in the list that needs checking", async ({ page }) => {
    await open(page, "#/");
    await page.locator("th[data-sort]").first().click();   // names Z to A
    const first = await page.evaluate(() => [...document.querySelectorAll("table.list tbody tr")].map((r) => r.dataset.go.split("/").pop()).find((id) => (window.__DB__.restriction_digest_experiments.some((e) => e.phage_id === id && !e.results_checked))));
    await expect(page.locator(".pager")).toContainText("10 to check in this list");
    await page.click('[data-act="checknext"]');
    await expect(page).toHaveURL(new RegExp(`#/phage/${first}/digest/x${first}$`));
  });

  test("a PhagesDB link in the list opens a new tab without opening the phage", async ({ page, context }) => {
    await open(page, "#/");
    const link = page.locator("table.list tbody tr").first().locator("a.pdbx");
    await expect(link).toHaveAttribute("href", /^https:\/\/phagesdb\.org\/phages\/.+\/$/);
    await context.route("https://phagesdb.org/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<title>stub</title>" }));
    const [popup] = await Promise.all([context.waitForEvent("page"), link.click()]);
    await popup.close();
    await expect(page).toHaveURL(/#\/$/);                  // still on the list
  });

  test("the Analysis table shows every phage in one scrolling box", async ({ page }) => {
    await open(page, "#/analysis");
    await page.waitForSelector("table.main");
    await expect(page.locator("button[data-anpage]")).toHaveCount(0);
    const n = await page.locator("table.main tbody tr").count();
    await expect(page.locator(".pager")).toContainText(`${n} of ${n} phages with results`);
    await page.selectOption('select[data-an="size"]', "10");
    const x = await page.evaluate(() => { const b = document.querySelector(".tablescroll.tall"), t = b.querySelector("table"); return { box: b.clientHeight, want: t.tHead.offsetHeight + 10 * t.tBodies[0].rows[0].offsetHeight, scrolls: b.scrollHeight > b.clientHeight + 4 }; });
    expect(Math.abs(x.box - x.want)).toBeLessThan(6);
    expect(x.scrolls).toBe(true);
    await page.locator('th[data-asort="main:blocked"]').scrollIntoViewIfNeeded();
    const before = await page.evaluate(() => window.scrollY);
    expect(before).toBeGreaterThan(200);
    await page.locator('th[data-asort="main:blocked"]').click();      // sorting does not move the page
    expect(Math.abs((await page.evaluate(() => window.scrollY)) - before)).toBeLessThan(5);
  });

  test("the phage page says where the genome sequence comes from", async ({ page }) => {
    await open(page, "#/");
    await page.evaluate(() => {
      window.__DB__.phage_workflow_status_public.push({ phage_id: "p02", selected_assembly_id: "asm-2", assembly_label: "Flye + Medaka (pipeline)", fasta_download_url: null, circularized: false });
      window.__FILES__.set("genome-fasta/assemblies/asm-2.fasta", ">g\nACGT\n");
      window.__FILES__.set("genome-fasta/p08.fasta", ">t\nACGT\n");
    });
    const go = (id) => page.evaluate((h) => { location.hash = h; }, `#/phage/${id}`);
    await go("p02");
    await expect(page.locator("p.gsrc")).toContainText("Rudner Lab database: Flye + Medaka (pipeline), linear");
    await go("p08");
    await expect(page.locator("p.gsrc")).toContainText("temporary upload on this site");
    await go("p05");
    await expect(page.locator("p.gsrc")).toContainText(/PhagesDB|none recorded/);
  });
});

test.describe("Digest page: enzyme list", () => {
  test("the enzyme tick-boxes stay in alphabetical order, an enzyme can be removed from the results, and the guide line starts on", async ({ page }) => {
    await open(page, "#/phage/p00");
    await page.locator('a.btn, button', { hasText: "Edit" }).first().click();
    await page.waitForSelector("table.results");
    await expect(page.locator("input[data-guide]")).toBeChecked();
    await expect(page.locator("#guide")).toBeVisible();
    const names = () => page.evaluate(() => [...document.querySelectorAll(".picks label.pick input[data-pick]")].map((i) => i.closest("label").querySelector("b").textContent));
    const heads = () => page.evaluate(() => [...document.querySelectorAll("table.results thead th .mv")].map((s) => s.childNodes[1].textContent.trim()));
    await page.evaluate(() => { for (const d of document.querySelectorAll("details")) d.open = true; });
    const before = await names();
    expect(before).toEqual(before.slice().sort((a, b) => a.localeCompare(b)));
    const h0 = await heads();
    expect(h0.length).toBeGreaterThan(2);
    // remove the second enzyme with its ✕
    await page.locator("table.results thead th").nth(2).locator("button.rm").click();
    const h1 = await heads();
    expect(h1).toEqual(h0.filter((n) => n !== h0[1]));
    await page.evaluate(() => { for (const d of document.querySelectorAll("details")) d.open = true; });
    expect(await names()).toEqual(before);   // the unticked enzyme has not moved
    const box = page.locator(".picks label.pick", { has: page.locator("b", { hasText: new RegExp("^" + h0[1] + "$") }) }).locator("input");
    await expect(box).not.toBeChecked();
  });
});

test.describe("Genome upload and checking order", () => {
  test("an uploaded genome can be marked circular, and a protein file is refused", async ({ page }) => {
    await open(page, "#/phage/p08/digest/xp08");
    await page.waitForSelector("table.results");
    const protein = ">gp1 capsid\n" + "MKTLLEDFQRWSPIVHYNAG".repeat(80) + "\n";
    await page.setInputFiles("[data-genomeup]", { name: "proteins.faa.txt", mimeType: "text/plain", buffer: Buffer.from(protein) });
    await expect(page.locator(".msg").first()).toContainText("looks like protein");
    expect(await page.evaluate(() => window.__FILES__.size)).toBe(0);
    const fasta = ">test genome\n" + "ACGT".repeat(300) + "GGATCC" + "ACGT".repeat(300) + "\n";
    await page.setInputFiles("[data-genomeup]", { name: "p08.fasta", mimeType: "text/plain", buffer: Buffer.from(fasta) });
    const line = page.locator(".card > p.sub").first();
    await expect(line).toContainText("linear");
    await page.click('[data-act="topo"]');
    await expect(line).toContainText("circular.");
    await expect(page.locator('[data-act="topo"]')).toHaveText("Change to linear");
    expect(await page.evaluate(() => window.__FILES__.get("genome-fasta/p08.fasta").split("\n")[0])).toBe(">test genome topology=circular");
    await page.click('[data-act="topo"]');
    await expect(line).toContainText("linear.");
    expect(await page.evaluate(() => window.__FILES__.get("genome-fasta/p08.fasta").split("\n")[0])).toBe(">test genome topology=linear");
  });

  test("a header that says circular is read on upload", async ({ page }) => {
    await open(page, "#/phage/p08/digest/xp08");
    await page.waitForSelector("table.results");
    const fasta = ">contig_1 length=2406 circular=true\n" + "ACGT".repeat(300) + "GGATCC" + "ACGT".repeat(300) + "\n";
    await page.setInputFiles("[data-genomeup]", { name: "p08.fasta", mimeType: "text/plain", buffer: Buffer.from(fasta) });
    await expect(page.locator(".card > p.sub").first()).toContainText("circular.");
  });

  test("Checked: save and next follows the order and filters of the Phages tab", async ({ page }) => {
    await open(page, "#/");
    await page.selectOption('select[data-lf="digest"]', "tocheck");
    // the list starts with the newest lab ID first
    const ids = await page.evaluate(() => [...document.querySelectorAll("table.list tbody tr")].map((r) => r.dataset.go.split("/").pop()));
    expect(ids.length).toBe(10);
    expect(ids).not.toEqual(ids.slice().sort());            // not the order of the catalogue
    await page.locator("table.list tbody tr").first().click();
    await page.locator('a.btn, button', { hasText: "Edit" }).first().click();
    await page.waitForSelector(".savebar");
    await page.click('[data-act="savenext"]');
    await expect(page).toHaveURL(new RegExp(`#/phage/${ids[1]}/digest/x${ids[1]}$`));
    await page.click('[data-act="savenext"]');
    await expect(page).toHaveURL(new RegExp(`#/phage/${ids[2]}/digest/x${ids[2]}$`));
  });

  test("the digest count and its 'to check' label share one line", async ({ page }) => {
    await open(page, "#/");
    const ws = await page.locator("table.list tbody tr").nth(1).locator("td").last().evaluate((td) => getComputedStyle(td).whiteSpace);
    expect(ws).toBe("nowrap");
  });
});

test.describe("Genome from the lab database", () => {
  test("the selected assembly's stored sequence is used before a temporary upload, with the assembly's topology", async ({ page }) => {
    await open(page, "#/");
    const genome = ">p08 annotated genome\n" + "ACGT".repeat(300) + "GGATCC" + "ACGT".repeat(300) + "\n";
    await page.evaluate((g) => {
      window.__DB__.phage_workflow_status_public.push({ phage_id: "p08", selected_assembly_id: "asm-8", assembly_label: "Flye + Medaka (pipeline)", assembly_sha256: "abc", fasta_download_url: null, circularized: true });
      window.__FILES__.set("genome-fasta/assemblies/asm-8.fasta", g);
      window.__FILES__.set("genome-fasta/p08.fasta", ">old temporary upload\n" + "A".repeat(1500) + "\n");
    }, genome);
    await page.evaluate(() => { location.hash = "#/phage/p08/digest/xp08"; });
    await page.waitForSelector("table.results");
    const line = page.locator(".card > p.sub").first();
    await expect(line).toContainText("Flye + Medaka (pipeline)");
    await expect(line).toContainText("2,406 bp");
    await expect(line).toContainText("circular.");
    await expect(page.locator("table.results tbody tr").nth(1).locator("td").first()).toContainText("1 cut");   // BamHI
    await expect(page.locator("[data-genomeup]")).toHaveCount(0);     // no stopgap upload once the database's copy is in use
    await expect(page.locator('[data-act="topo"]')).toHaveCount(0);
  });
});

test.describe("Phage page title", () => {
  test("the phage name links to its PhagesDB page, except for Staphylococcus phages", async ({ page }) => {
    await open(page, "#/");
    await page.addInitScript(() => { const c = window.__DB__.phage_catalog_public; c[3].host_genus = "Staphylococcus"; c[4].phage_name = "Asiskî"; });
    await page.reload();
    await page.waitForSelector("table.list tbody tr");
    const name = await db(page, "D.phage_catalog_public[2].phage_name");
    const go = (id) => page.evaluate((h) => { location.hash = h; }, `#/phage/${id}`);
    await go("p02");
    const link = page.locator("h2 a.pdb");
    await expect(link).toHaveAttribute("href", `https://phagesdb.org/phages/${name}/`);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toContainText(name);
    await go("p04");
    await expect(link).toHaveAttribute("href", "https://phagesdb.org/phages/Asiski/");   // the accent is dropped in the address
    await expect(link).toContainText("Asiskî");
    await go("p03");
    await expect(page.locator(".phead h2")).toContainText(await db(page, "D.phage_catalog_public[3].phage_name"));
    await expect(page.locator("h2 a.pdb")).toHaveCount(0);
  });
});

// A made-up PhagesDB address that answers with one of the fixture files, readable from another site
const PDB = "https://phagesdb.org/media/digestPics/";
async function serve(page, name, fixture) {
  await page.route(PDB + name, (r) => (fixture ? r.fulfill({ status: 200, contentType: "application/octet-stream", headers: { "access-control-allow-origin": "*" }, body: require("fs").readFileSync(path.join(__dirname, "fixtures", fixture)) }) : r.abort()));
}

test.describe("Default order and TIFF images", () => {
  test("the Phages tab starts with the most recent Rudner Lab ID", async ({ page }) => {
    await open(page, "#/");
    const ids = await cells(page.locator("table.list tbody tr td:nth-child(2)"));
    expect(ids.length).toBe(12);
    expect(ids).toEqual(ids.slice().sort().reverse());
    await expect(page.locator("th[data-sort]").nth(1).locator(".arrow")).toHaveText("▼");
  });

  for (const name of ["gel16.tif", "gel16-deflate.tif", "gel8.tif"]) {
    test(`a TIFF gel (${name}) is converted and stored as a JPEG`, async ({ page }) => {
      await open(page, "#/phage/p11");
      await page.waitForSelector(".phead");
      await page.setInputFiles("[data-replicate]", path.join(__dirname, "fixtures", name));
      await expect(page.locator(".msg").first()).toContainText("TIFF was converted");
      const stored = await page.evaluate(() => [...window.__FILES__.keys()].filter((k) => k.startsWith("digest-images/")));
      expect(stored.length).toBe(1);
      expect(stored[0]).toMatch(/\.jpg$/);
    });
  }

  test("a 16-bit TIFF that uses little of its range is stretched so the bands show", async ({ page }) => {
    await serve(page, "A_Digest.tif", "gel16.tif");
    await open(page, "#/");
    const r = await page.evaluate(async () => {
      const buf = await (await fetch("https://phagesdb.org/media/digestPics/A_Digest.tif")).arrayBuffer();
      await new Promise((res, rej) => { const a = document.createElement("script"); a.src = "js/vendor/pako_inflate.min.js"; a.onload = () => { const b = document.createElement("script"); b.src = "js/vendor/UTIF.js"; b.onload = res; b.onerror = rej; document.head.appendChild(b); }; a.onerror = rej; document.head.appendChild(a); });
      const ifd = window.UTIF.decode(buf)[0]; window.UTIF.decodeImage(buf, ifd);
      const plain = window.UTIF.toRGBA8(ifd); let pmax = 0; for (let i = 0; i < plain.length; i += 4) pmax = Math.max(pmax, plain[i]);
      return { w: ifd.width, h: ifd.height, bits: ifd.t258[0], plainMax: pmax };
    });
    expect(r).toMatchObject({ w: 320, h: 240, bits: 16 });
    expect(r.plainMax).toBeLessThan(20);          // without stretching, this gel would look black
  });

  test("a phage record's TIFF image is converted and shown on the phage and digest pages", async ({ page }) => {
    await serve(page, "A_Digest.tif", "gel16.tif"); await serve(page, "B_Digest.pdf", "gel-two-pages.pdf"); await serve(page, "Missing_Digest.tif", null);
    await open(page, "#/");
    await page.addInitScript((base) => { const c = window.__DB__.phage_catalog_public; c[6].restriction_digest_image_url = base + "A_Digest.tif"; c[5].restriction_digest_image_url = base + "Missing_Digest.tif"; c[4].restriction_digest_image_url = base + "B_Digest.pdf"; }, PDB);
    await page.reload();
    await page.waitForSelector("table.list tbody tr");
    const go = (h) => page.evaluate((x) => { location.hash = x; }, h);
    await go("#/phage/p06");
    const img = page.locator(".imgbox img").first();
    await expect(img).toHaveAttribute("src", /^blob:/);
    const px = await img.evaluate(async (el) => { await el.decode(); const c = document.createElement("canvas"); c.width = el.naturalWidth; c.height = el.naturalHeight; const g = c.getContext("2d"); g.drawImage(el, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data; let max = 0, sum = 0; for (let i = 0; i < d.length; i += 4) { max = Math.max(max, d[i]); sum += d[i]; } return { w: c.width, h: c.height, max, mean: sum / (d.length / 4) }; });
    expect(px).toMatchObject({ w: 320, h: 240 });
    expect(px.max).toBeGreaterThan(200);          // bands are bright
    expect(px.mean).toBeLessThan(90);             // the background stays dark
    await go("#/phage/p06/digest/xp06");
    await expect(page.locator(".zoomwrap img.big")).toHaveAttribute("src", /^blob:/);
    await expect(page.locator("#gels")).toContainText("Open the original TIFF");
    await go("#/phage/p04");                         // a PDF address is converted the same way
    await expect(page.locator(".imgbox img").first()).toHaveAttribute("src", /^blob:/);
    await go("#/phage/p05");                         // one that cannot be fetched says so and links to the original
    await expect(page.locator(".imgbox .note.warn")).toContainText("can't be shown here");
    await expect(page.locator(`.imgbox .note.warn a[href="${PDB}Missing_Digest.tif"]`)).toHaveCount(1);
  });
});

test.describe("Figure 2: plot, filter panel and table", () => {
  const ready = async (page) => { await open(page, "#/analysis"); await page.waitForSelector("table.fig2"); };
  const dots = (page) => page.locator("#gcat circle[data-pid]");

  test("the table's controls sit under the plot, and the filter panel beside it filters both", async ({ page }) => {
    await ready(page);
    const fig = page.locator('details[data-sec="fig2"]');
    // order on the page: plot, then the Rows shown control, then the table
    const y = await fig.evaluate((d) => ({ plot: d.querySelector("#gcat").getBoundingClientRect().bottom, rows: d.querySelector('select[data-an="f2.size"]').getBoundingClientRect().top, table: d.querySelector("table.fig2").getBoundingClientRect().top, panelLeft: d.querySelector(".f2panel").getBoundingClientRect().left, plotRight: d.querySelector("#gcat").getBoundingClientRect().right }));
    expect(y.rows).toBeGreaterThan(y.plot);
    expect(y.table).toBeGreaterThan(y.rows);
    expect(y.panelLeft).toBeGreaterThan(y.plotRight);            // the panel uses the space to the right of the plot
    await expect(fig.locator("table.fig2 tr.filters")).toHaveCount(0);
    await expect(fig).not.toContainText("Show first");
    const all = await dots(page).count();
    expect(all).toBe(11);
    await expect(fig.locator("table.fig2 tbody tr")).toHaveCount(11);     // every phage is in the table; the box scrolls
    const host = await db(page, "(() => { const p = D.phage_catalog_public[1]; return [p.host_genus, p.host_species, p.host_strain].filter(Boolean).join(' '); })()");
    const opts = await page.locator('select[data-an="f2.f.host"] option').allInnerTexts();
    expect(opts[0]).toBe("all"); expect(opts.length).toBeGreaterThan(2);
    await page.selectOption('select[data-an="f2.f.host"]', { index: 1 });
    const n = await fig.locator("table.fig2 tbody tr").count();
    expect(n).toBeLessThan(11); expect(n).toBeGreaterThan(0);
    await expect(dots(page)).toHaveCount(n);
    await expect(fig.locator(".scatter")).toContainText(`the filters leave ${n} of 11 phages`);
    await expect(fig.locator(".f2panel")).toContainText(`${n} of 11 phages match the filters`);
    await page.selectOption('select[data-an="f2.f.chk"]', "yes");          // only Phage00 has a checked digest
    const checked = await cells(fig.locator("table.fig2 tbody tr td:first-child"));
    expect(checked.every((x) => x === "Phage00")).toBe(true);
    await page.click('[data-act="f2clear"]');
    await expect(dots(page)).toHaveCount(11);
    await expect(page.locator('[data-act="f2clear"]')).toBeDisabled();
    await page.selectOption('select[data-an="f2.f.chk"]', "yes");
    await expect(fig.locator("table.fig2 tbody tr")).toHaveCount(1);
    await expect(fig.locator("table.fig2 tbody tr td").first()).toHaveText("Phage00");
    await page.selectOption('select[data-an="f2.f.chk"]', "no");
    await expect(fig.locator("table.fig2 tbody tr")).toHaveCount(10);
    await page.click('[data-act="f2clear"]');
    await page.selectOption('select[data-an="f2.f.cluster"]', "AZ");
    const az = await db(page, "D.phage_catalog_public.filter((p) => p.phagesdb_cluster === 'AZ' && D.restriction_digest_experiments.some((e) => e.phage_id === p.phage_id)).length");
    await expect(fig.locator("table.fig2 tbody tr")).toHaveCount(az);
  });

  test("the dots can be coloured by another property, and the choice survives Clear filters", async ({ page }) => {
    await ready(page);
    await expect(page.locator("#gcat")).toContainText("Host genus");
    const fills = async () => new Set(await dots(page).evaluateAll((cs) => cs.map((c) => c.getAttribute("fill"))));
    const byHost = await fills();
    await page.selectOption('select[data-an="f2.f.color"]', "call");
    await expect(page.locator("#gcat")).toContainText("Likely modified");
    await expect(page.locator("#gcat")).toContainText("G/C (");
    const byCall = await fills();
    expect([...byCall].sort()).not.toEqual([...byHost].sort());
    expect(byCall.has("#0072B2")).toBe(true);                       // the G/C colour
    await page.selectOption('select[data-an="f2.f.chk"]', "no");
    await page.click('[data-act="f2clear"]');
    await expect(page.locator('select[data-an="f2.f.color"]')).toHaveValue("call");
    await page.selectOption('select[data-an="f2.f.color"]', "chk");
    await expect(page.locator("#gcat")).toContainText("not yet checked (10)");
  });

  test("pointing at a row marks its dot, and pointing at a dot marks its row", async ({ page }) => {
    await ready(page);
    const row = page.locator("table.fig2 tbody tr").nth(2), pid = await row.getAttribute("data-pid");
    await row.hover();
    await expect(page.locator(`#gcat circle[data-pid="${pid}"]`)).toHaveClass(/hl/);
    await expect(page.locator("#gcat circle.hl")).toHaveCount(1);
    const last = page.locator("table.fig2 tbody tr").last(), lastPid = await last.getAttribute("data-pid");
    await page.locator(`#gcat circle[data-pid="${lastPid}"]`).dispatchEvent("mouseover");
    await expect(last).toHaveClass(/hl/);
    await expect(page.locator("table.fig2 tr.hl")).toHaveCount(1);
    const inView = await last.evaluate((r) => { const b = r.closest(".listbox"); return r.offsetTop + r.offsetHeight <= b.scrollTop + b.clientHeight + 1; });
    expect(inView).toBe(true);                                       // the box scrolled to the row
    await page.locator("h2").first().hover();
    await expect(page.locator("#gcat circle.hl, table.fig2 tr.hl")).toHaveCount(0);
  });

  test("Figures 3 and 4 list every row in a scrolling box", async ({ page }) => {
    await ready(page);
    for (const f of ["f3", "f4"]) {
      const sel = page.locator(`select[data-an="${f}.size"]`);
      await expect(sel).toHaveValue("15");
      expect(await sel.locator("option").allInnerTexts()).toEqual(["10", "15", "20", "40", "fit the window"]);
    }
    await expect(page.locator('details[data-sec="fig3"] .listbox')).toHaveCount(1);
    await expect(page.locator('details[data-sec="fig4"] .listbox table.fig4 tbody tr')).toHaveCount(5);
    for (const f of ["fig3", "fig4"]) await expect(page.locator(`details[data-sec="${f}"]`)).not.toContainText("first 15");
  });
});

