// Virtual digests: finding recognition sites, fragment sizes and drawing the gel. No network, no page state.
(function () {
  const IUPAC = { A: "A", C: "C", G: "G", T: "T", R: "[AG]", Y: "[CT]", S: "[GC]", W: "[AT]", K: "[GT]", M: "[AC]", B: "[CGT]", D: "[AGT]", H: "[ACT]", V: "[ACG]", N: "[ACGT]" };
  const LADDER_BP = [10000, 8000, 6000, 5000, 4000, 3000, 2000, 1500, 1000, 750, 500, 250];
  // The ladders used in the lab, as [bp, ng per lane]; the same values as on the phage coverage reports. Heavier bands are drawn thicker.
  const LADDERS = {
    "1 kb ladder (EcoRV + NcoI)": [[10000, 60], [7750, 55], [5000, 65], [4000, 65], [3000, 60], [2000, 45], [1500, 35], [1000, 25], [750, 25], [250, 10]],
    "100 bp ladder (PstI + NcoI)": [[10000, 45], [7750, 40], [4100, 130], [2000, 35], [1500, 32], [1000, 22], [900, 20], [800, 19], [700, 18], [600, 17], [500, 16], [400, 14], [300, 12], [200, 10], [100, 8]],
    "1 kb ladder (NEB)": [[10000, 42], [8000, 42], [6000, 50], [5000, 42], [4000, 33], [3000, 125], [2000, 48], [1500, 36], [1000, 42], [500, 42]],
    "100 bp ladder (NEB)": [[1517, 45], [1200, 35], [1000, 95], [900, 27], [800, 24], [700, 21], [600, 18], [517, 49], [500, 48], [400, 38], [300, 29], [200, 25], [100, 48]]
  };
  const ladderBands = (name) => LADDERS[name] || LADDER_BP.map((bp) => [bp, bp === 3000 || bp === 1000 ? 100 : 40]);
  const esc = (x) => String(x == null ? "" : x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function parseFasta(text) {
    const lines = String(text || "").split(/\r?\n/);
    const head = (lines.find((l) => l.startsWith(">")) || "").slice(1).trim();
    const seq = lines.filter((l) => !l.startsWith(">")).join("").replace(/[^ACGTRYSWKMBDHVN]/gi, "").toUpperCase();
    return { name: head, seq };
  }

  // Same rule as the Observable page: every match of the recognition sequence is a cut; fragments sorted largest first.
  function digest(seq, motif, circular) {
    const rx = new RegExp(String(motif || "").toUpperCase().split("").map((c) => IUPAC[c] || c).join(""), "g");
    const cuts = [];
    let m;
    if (motif) while ((m = rx.exec(seq)) !== null) { cuts.push(m.index); rx.lastIndex = m.index + 1; }
    if (!cuts.length) return { sites: 0, fragments: [seq.length] };
    const fr = [];
    if (circular) {
      for (let i = 0; i < cuts.length; i++) { const a = cuts[i], b = cuts[(i + 1) % cuts.length]; fr.push(i === cuts.length - 1 ? seq.length - a + b : b - a); }
    } else {
      fr.push(cuts[0]);
      for (let i = 1; i < cuts.length; i++) fr.push(cuts[i] - cuts[i - 1]);
      fr.push(seq.length - cuts[cuts.length - 1]);
    }
    return { sites: cuts.length, fragments: fr.filter((x) => x > 0).sort((a, b) => b - a) };
  }

  // lanes: [{label, kind: "ladder" | "bands", fragments: [bp]}]. Returns an SVG string, bands on a log scale.
  // opts: ladder (name of the ladder to draw), height, run (run time, 1 = standard), gap (space between lanes; 0 makes them touch), numbers / names / scale (false hides those labels).
  function gelSvg(lanes, opts) {
    opts = opts || {};
    const H = opts.height || 300, laneW = 46, gap = opts.gap == null ? 0 : opts.gap, padB = 10;
    const showNum = opts.numbers !== false, showName = opts.names !== false, showScale = opts.scale !== false;
    const top = 6 + (showNum ? 12 : 0) + (showName ? 12 : 0), left = showScale ? 40 : 4;
    const lad = ladderBands(opts.ladder), ladBp = lad.map((b) => b[0]), heavy = new Set(lad.filter((b) => b[1] >= 90).map((b) => b[0]));
    const all = lanes.flatMap((l) => (l.kind === "ladder" ? ladBp : l.fragments || []));
    const maxBp = Math.max(10000, ...all), minBp = 100;
    // run: how long the gel ran. 1 puts the 100 bp band at the bottom; more moves everything further and small bands run off.
    const run = opts.run || 1;
    const y = (bp) => top + 8 + (Math.log10(maxBp) - Math.log10(Math.max(bp, minBp))) / (Math.log10(maxBp) - Math.log10(minBp)) * (H - 20) * run;
    const onGel = (bp) => y(bp) <= top + H - 3;
    const W = left + lanes.length * laneW + Math.max(0, lanes.length - 1) * gap + 4;
    let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${top + H + padB}" width="${W}" height="${top + H + padB}" role="img" aria-label="Virtual digest">`;
    if (showScale) {
      s += `<g font-family="system-ui,Arial,sans-serif" font-size="9" fill="#5f6368" text-anchor="end">`;
      for (const bp of ladBp.filter(onGel)) s += `<text x="${left - 5}" y="${(y(bp) + 3).toFixed(1)}">${bp >= 1000 ? bp / 1000 + " kb" : bp}</text>`;
      s += `</g>`;
    }
    s += `<rect x="${left}" y="${top}" width="${W - left - 4}" height="${H}" rx="4" fill="${gap ? "none" : "#111"}"/>`;
    lanes.forEach((l, i) => {
      const x = left + i * (laneW + gap);
      if (showNum) s += `<text x="${x + laneW / 2}" y="${showName ? top - 16 : top - 4}" font-family="system-ui,Arial,sans-serif" font-size="10" font-weight="700" fill="#202124" text-anchor="middle">${i + 1}</text>`;
      if (showName) s += `<text x="${x + laneW / 2}" y="${top - 4}" font-family="system-ui,Arial,sans-serif" font-size="9.5" fill="#202124" text-anchor="middle">${esc(l.label)}</text>`;
      if (gap) s += `<rect data-lane="1" x="${x}" y="${top}" width="${laneW}" height="${H}" rx="4" fill="#111"/>`;
      else s += `<rect data-lane="1" x="${x}" y="${top}" width="${laneW}" height="${H}" fill="none"><title>${i + 1}. ${esc(l.label)}</title></rect>`;
      const bands = (l.kind === "ladder" ? ladBp : (l.fragments || []).slice(0, 80)).filter(onGel);
      for (const bp of bands) {
        const thick = l.kind === "ladder" && heavy.has(bp) ? 3.5 : 2;
        s += `<rect x="${x + 5}" y="${(y(bp) - thick / 2).toFixed(1)}" width="${laneW - 10}" height="${thick}" fill="${l.kind === "ladder" ? "#cfd8dc" : "#fff"}"><title>${esc(l.label)}: ${Number(bp).toLocaleString()} bp</title></rect>`;
      }
    });
    return s + `</svg>`;
  }

  // Words in gene annotations that point at DNA modification, as on the Observable page.
  const MOD_TERMS = ["glycosyltransferase", "methyltransferase", "hydroxymethyl", "glucosyl", "dna modification", "dcm", "dam methyl", "thymidylate synthase"];

  // How useful an enzyme is for a first digest: a handful of sites gives a readable pattern.
  function usefulness(sites) {
    if (sites === 0) return { score: 0, note: "No sites: stays uncut (a negative control)" };
    if (sites >= 2 && sites <= 20) return { score: 3, note: "Good: a clear band pattern" };
    if (sites === 1) return { score: 2, note: "One site: a single cut" };
    if (sites <= 40) return { score: 2, note: "Many bands" };
    return { score: 1, note: "Very many small bands; hard to read" };
  }

  window.Digest = { parseFasta, digest, gelSvg, MOD_TERMS, usefulness, LADDER_BP, LADDERS, esc };
})();
