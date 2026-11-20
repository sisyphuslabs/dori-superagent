// The agent launch command Dori would type into a shell, read back into what an omo session can be told instead: the
// omo runtime has no shell, the session it opens already runs omo, so the command's model and first text are applied to
// that session (`omo remote model` / `omo remote send`) rather than typed.

/** Splits a command line the way a POSIX shell reads words: single quotes, double quotes and backslash escapes. */
export function shellWords(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) throw new Error(`unterminated single quote in ${JSON.stringify(line)}`);
      word += line.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < line.length && line.charAt(j) !== '"'; j++) {
        if (line.charAt(j) === "\\" && j + 1 < line.length) j++;
        word += line.charAt(j);
      }
      if (j >= line.length) throw new Error(`unterminated double quote in ${JSON.stringify(line)}`);
      inWord = true;
      i = j;
    } else if (c === "\\" && i + 1 < line.length) {
      word += line.charAt(++i);
      inWord = true;
    } else if (c === " " || c === "\t" || c === "\n") {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else {
      word += c;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words;
}

/** What a launch command asks of the session: a model, a system-prompt addition, the first text. */
export type AgentLaunch = { readonly model?: string; readonly appendSystemPrompt?: string; readonly prompt?: string };

/** The omo CLI flags Dori's commands use; any other flag is refused, because dropping it would change the session. */
export function parseLaunch(command: string, agentBin = "omo"): AgentLaunch {
  const [bin, ...rest] = shellWords(command);
  if (bin === undefined || bin.split("/").at(-1) !== agentBin)
    throw new Error(`the omo runtime only starts ${agentBin} sessions, not ${JSON.stringify(command)}`);
  const launch: { model?: string; appendSystemPrompt?: string; prompt?: string } = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    const value = (): string => {
      const next = rest[++i];
      if (next === undefined) throw new Error(`${arg} needs a value in ${JSON.stringify(command)}`);
      return next;
    };
    if (arg === "--model") launch.model = value();
    else if (arg === "--append-system-prompt") launch.appendSystemPrompt = value();
    else if (arg.startsWith("-")) throw new Error(`the omo runtime cannot apply ${arg} to a remote session`);
    else if (launch.prompt === undefined) launch.prompt = arg;
    else throw new Error(`more than one prompt in ${JSON.stringify(command)}`);
  }
  return launch;
}
