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
    await expect(page).toHaveURL(/#\/phage\/p02\/digest\/xp02$/);
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
    await expect(page.locator(".card > p.sub").first()).toContainText("Genome uploaded by the lab");
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
    await page.selectOption('[data-an="f2.size"]', "all");
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
