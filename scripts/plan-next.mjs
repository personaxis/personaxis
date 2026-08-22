#!/usr/bin/env node
// Writes the handoff, so nobody has to remember to.
//
//   pnpm plan:next
//
// The document this replaces grew to 1.596 lines because every session appended
// to it and none of them removed anything. It was called "next steps" and had
// become a log, which is the worst of both: too long to read on resuming and too
// unstructured to search. Its content is kept as history.
//
// This derives the handoff from the ledger instead: the first task that is not
// closed, what it waits on, and where the work stands. Derived means it cannot go
// stale, because there is nothing to forget to update.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const PHASES = join(ROOT, "plan", "runtime", "phases");
const OUT = join(ROOT, "plan", "NEXT_STEPS.md");

const ROW = /^\|\s*([A-Z]+\d+)\s*\|([^|]*)\|\s*(todo|doing|blocked|done)\s*\|([^|]*)\|([^|]*)\|/;
const TITLE = /^title:\s*"?(.+?)"?$/m;

const phases = readdirSync(PHASES)
	.filter((name) => name.endsWith(".md"))
	.sort()
	.map((name) => {
		const source = readFileSync(join(PHASES, name), "utf8");
		const tasks = [];
		for (const line of source.split("\n")) {
			const row = ROW.exec(line.trim());
			if (!row) continue;
			tasks.push({
				id: row[1],
				what: row[2].trim(),
				state: row[3],
				commit: row[4].replace(/[`\s]/g, ""),
			});
		}
		return { file: name, title: TITLE.exec(source)?.[1] ?? name, tasks };
	});

const all = phases.flatMap((phase) => phase.tasks);
const done = all.filter((task) => task.state === "done");
const doing = all.filter((task) => task.state === "doing");
const blocked = all.filter((task) => task.state === "blocked");

/** The first thing that is not finished, in ledger order. */
const next = all.find((task) => task.state !== "done");
const nextPhase = phases.find((phase) => phase.tasks.some((task) => task === next));

const today = new Date().toISOString().slice(0, 10);
const lines = [];

lines.push("---");
lines.push('title: "Dónde retomar"');
lines.push("version: 1.0.0");
lines.push(`date: ${today}`);
lines.push("status: active");
lines.push("plan: runtime/README.md");
lines.push("---");
lines.push("");
lines.push("# Dónde retomar");
lines.push("");
lines.push(
	"**Generado por `pnpm plan:next`. No se edita a mano**, porque un handoff escrito a mano es",
);
lines.push("un handoff que se queda viejo. Si algo de aquí está mal, lo que está mal es el libro.");
lines.push("");
lines.push(`Avance: **${done.length} de ${all.length}** tareas cerradas.`);
lines.push("");

if (!next) {
	lines.push("Todas las tareas del libro están cerradas.");
} else {
	lines.push("## Lo siguiente");
	lines.push("");
	lines.push(`**${next.id}, ${next.what}**`);
	lines.push("");
	lines.push(`Fase: ${nextPhase?.title ?? "?"} (\`plan/runtime/phases/${nextPhase?.file}\`)`);
	lines.push("");
}

if (doing.length) {
	lines.push("## Empezado y sin cerrar");
	lines.push("");
	for (const task of doing) lines.push(`- **${task.id}**, ${task.what}`);
	lines.push("");
}

if (blocked.length) {
	lines.push("## Bloqueado");
	lines.push("");
	for (const task of blocked) lines.push(`- **${task.id}**, ${task.what}`);
	lines.push("");
}

lines.push("## Por fase");
lines.push("");
lines.push("| Fase | Cerradas | Total |");
lines.push("|---|---|---|");
for (const phase of phases) {
	const closed = phase.tasks.filter((task) => task.state === "done").length;
	lines.push(`| ${phase.title} | ${closed} | ${phase.tasks.length} |`);
}
lines.push("");

if (done.length) {
	lines.push("## Lo último cerrado");
	lines.push("");
	for (const task of done.slice(-5)) {
		lines.push(`- **${task.id}**, ${task.what} · \`${task.commit}\``);
	}
	lines.push("");
}

writeFileSync(OUT, `${lines.join("\n")}\n`);
console.log(`plan/NEXT_STEPS.md: ${done.length}/${all.length} cerradas, siguiente ${next?.id ?? "ninguna"}`);
