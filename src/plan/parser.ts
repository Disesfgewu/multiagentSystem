export interface PlanTask {
  id: string;
  title: string;
  done: boolean;
  line: number;
  reports: PlanReportLink[];
}
// `field` says which labelled field this reference came from. Only 'evidence' links may ever be
// compared against live GitHub state to flag a conflict with the checkbox: a 'dependency' link is
// informational only, and a dependency Issue being open must never be read as this TODO failing.
export interface PlanReportLink { kind: 'issue' | 'pullRequest'; number: number; field: 'dependency' | 'evidence' }
export interface PlanSection {
  title: string;
  tasks: PlanTask[];
}
export interface PlanParse {
  sections: PlanSection[];
  errors: string[];
}
const TASK = /^- \[([ x])\] ([A-Z]+[0-9]*-[0-9]{3}) (.+)$/;
const CANDIDATE = /^- \[[^\]]*\]/;

/** Only labelled dependency/evidence fields are links. Bare evidence numbers are ambiguous. */
export function planReportLinks(source: string): PlanReportLink[] {
  const reports: PlanReportLink[] = [];
  const index = new Map<string, PlanReportLink>();
  // A Markdown link can target another repository even when its label says PR #7.
  const localText = source.replace(/\[[^\]]*\]\([^)]*\)/g, '');
  for (const field of localText.matchAll(/(?:依賴|dependency|證據|evidence)[:：]\s*([^;；\n]*)/gi)) {
    const dependency = /^(?:依賴|dependency)/i.test(field[0]);
    const fieldKind: PlanReportLink['field'] = dependency ? 'dependency' : 'evidence';
    let previousKind: PlanReportLink['kind'] | undefined;
    let previousEnd = 0;
    for (const ref of field[1].matchAll(/(?<![A-Za-z0-9_/.:-])(?:\b(PR|Issues?|Pull Request)\s*)?#\s*([1-9][0-9]*)\b/gi)) {
      const explicit = ref[1] ? (/^(PR|Pull Request)$/i.test(ref[1]) ? 'pullRequest' : 'issue') : undefined;
      const continued = previousKind && /^[\s/／、,，&及與]*$/.test(field[1].slice(previousEnd, ref.index));
      const kind = explicit ?? (continued ? previousKind : dependency ? 'issue' : undefined);
      const number = Number(ref[2]);
      previousKind = kind;
      previousEnd = ref.index! + ref[0].length;
      if (!kind || !Number.isSafeInteger(number)) continue;
      const key = `${kind}:${number}`;
      const existing = index.get(key);
      if (!existing) {
        const link: PlanReportLink = { kind, number, field: fieldKind };
        index.set(key, link);
        reports.push(link);
      } else if (existing.field === 'dependency' && fieldKind === 'evidence') {
        // The same reference named again, more specifically, as this TODO's own acceptance
        // evidence: it now participates in the conflict check, not just as a plain dependency.
        existing.field = 'evidence';
      }
    }
  }
  return reports;
}

/** Parse checklist headings as data. Invalid or duplicate IDs never point to the wrong line. */
export function parsePlan(source: string): PlanParse {
  const sections: PlanSection[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  let section: PlanSection | undefined;
  source.split(/\r?\n/).forEach((line, index) => {
    if (line.startsWith('## ')) {
      section = { title: line.slice(3).trim().slice(0, 160), tasks: [] };
      sections.push(section);
      return;
    }
    if (!CANDIDATE.test(line)) return;
    const match = TASK.exec(line);
    if (!match || !section) {
      errors.push(`Line ${index + 1}: checklist item needs a section and a stable ID, such as M1-001.`);
      return;
    }
    if (seen.has(match[2])) {
      errors.push(`Line ${index + 1}: duplicate ID ${match[2]}.`);
      return;
    }
    seen.add(match[2]);
    const title = match[3].split('。負責：')[0].trim();
    section.tasks.push({ id: match[2], title: title.slice(0, 180), done: match[1] === 'x', line: index, reports: planReportLinks(line) });
  });
  return { sections: sections.filter((entry) => entry.tasks.length > 0), errors };
}
