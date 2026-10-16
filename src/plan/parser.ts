export interface PlanTask {
  id: string;
  title: string;
  done: boolean;
  line: number;
}
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
    section.tasks.push({ id: match[2], title: title.slice(0, 180), done: match[1] === 'x', line: index });
  });
  return { sections: sections.filter((entry) => entry.tasks.length > 0), errors };
}
