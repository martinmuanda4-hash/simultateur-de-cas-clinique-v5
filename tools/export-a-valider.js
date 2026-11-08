#!/usr/bin/env node
"use strict";

/*
 * Lists, as Markdown, everything in a case's history taking that was written
 * as a proposal and must be validated by a clinician:
 *   - answers marked "aValider": true in the case file;
 *   - normal default answers used because the case did not define the question;
 *   - the "pourquoi" teaching texts of the key questions.
 *
 *   node tools/export-a-valider.js [path/to/case.json] > A-VALIDER-anamnese.md
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(file, "utf8");
const src = read(path.join(ROOT, "app.js"));
const ui = JSON.parse(read(path.join(ROOT, "data", "interface.json")));
const index = JSON.parse(read(path.join(ROOT, "data", "cas-index.json")));
const caseFile = process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) : path.join(ROOT, index.cas[0].fichier);
const data = JSON.parse(read(caseFile));

const api = new Function(src.split("/* Score")[0] + "; return { buildAnamnesisItems };")();
const config = ui.anamnese;
const items = api.buildAnamnesisItems(data.etapes.etape1_anamnese, config);
const titleOf = (id) => (config.rubriques.find((r) => r.id === id) || { titre: id }).titre;
const level = { cle: "clé", utile: "utile", systematique: "systématique" };

const out = [];
out.push("# À valider : anamnèse du cas « " + data.titre + " »");
out.push("");
out.push("Document généré automatiquement (`node tools/export-a-valider.js`). Pour chaque réponse : confirmer, ou donner la version correcte, en gardant le ton d'un proche qui parle (première personne).");
out.push("");

const proposed = items.filter((i) => i.aValider);
out.push("## 1. Réponses proposées à confirmer (" + proposed.length + ")");
out.push("");
config.rubriques.forEach((rubrique) => {
  const rows = proposed.filter((i) => i.rubrique === rubrique.id);
  if (rows.length === 0) return;
  out.push("### " + rubrique.titre);
  out.push("");
  rows.forEach((i) => {
    out.push("- **" + i.libelle + "** (" + level[i.pertinence] + ")");
    out.push("  - Question type : « " + i.questionExemple + " »");
    out.push("  - Réponse de la famille : « " + i.reponse + " »");
    out.push("  - Note du carnet : " + i.note);
    out.push("  - [ ] Validé   [ ] À corriger : ………………………………");
  });
  out.push("");
});

const defaults = items.filter((i) => i.fromDefault);
out.push("## 2. Réponses normales par défaut (" + defaults.length + ")");
out.push("");
out.push("Ces questions ne sont pas définies dans le cas : la famille répond « normal ». À corriger si une de ces réponses est incompatible avec le cas.");
out.push("");
defaults.forEach((i) => out.push("- **" + i.libelle + "** : « " + i.reponse + " »"));
out.push("");

const keys = items.filter((i) => i.pertinence === "cle");
out.push("## 3. Textes pédagogiques des questions clés (" + keys.length + ")");
out.push("");
out.push("Affichés au débriefing (« Pourquoi c'est important »). À relire pour l'exactitude médicale.");
out.push("");
keys.forEach((i) => out.push("- **" + i.libelle + "** : " + (i.pourquoi || "(aucun texte)")));
out.push("");

process.stdout.write(out.join("\n"));

