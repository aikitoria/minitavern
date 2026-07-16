import { For, Show, createEffect, createSignal } from 'solid-js';
import { api } from '../state/api.ts';
import { activePath, state, streamingMessage, toast } from '../state/store.ts';

const coarsePointer = matchMedia('(pointer: coarse)').matches;

const SendIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
    <path d="M3.4 20.4 20.85 12.92c.8-.35.8-1.49 0-1.84L3.4 3.6c-.66-.29-1.39.2-1.39.91L2 9.12c0 .5.37.93.87.99L16 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z" />
  </svg>
);

const ResumeIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    stroke-width="2.4"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M5 5l7 7-7 7" />
    <path d="M13 5l7 7-7 7" />
  </svg>
);

const StopIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
    <rect x="5" y="5" width="14" height="14" rx="2" />
  </svg>
);

interface Command {
  name: string;
  params: string;
  description: string;
  run: (args: string) => Promise<void>;
}

const COMMANDS: Command[] = [
  {
    name: 'char',
    params: '<name>',
    description:
      'Set the assistant speaker name for this conversation (empty resets to the character)',
    run: async (args) => {
      if (state.selectedId == null) throw new Error('no conversation selected');
      await api.patchConversation(state.selectedId, { speakerName: args.trim() || null });
    },
  },
];

export default function Composer() {
  const [text, setText] = createSignal('');
  const [selIdx, setSelIdx] = createSignal(0);
  let area: HTMLTextAreaElement | undefined;

  // "/cha" -> completion menu; "/char args" -> parameter hint.
  const cmdQuery = () => {
    const m = text().match(/^\/(\w*)$/);
    return m ? m[1]! : null;
  };
  const cmdMatches = () => {
    const q = cmdQuery();
    return q != null ? COMMANDS.filter((c) => c.name.startsWith(q.toLowerCase())) : [];
  };
  const activeCmd = () => {
    const m = text().match(/^\/(\w+)\s/);
    return m ? COMMANDS.find((c) => c.name === m[1]!.toLowerCase()) : undefined;
  };

  createEffect(() => {
    void text();
    setSelIdx(0);
  });

  const complete = (cmd: Command) => {
    setText(`/${cmd.name} `);
    area?.focus();
  };

  const resize = () => {
    if (!area) return;
    area.style.height = 'auto';
    area.style.height = `${Math.min(area.scrollHeight, 200)}px`;
    // Only scroll once the max height is actually reached; otherwise sub-pixel
    // rounding makes the browser show a scrollbar on a single line.
    area.style.overflowY = area.scrollHeight > 200 ? 'auto' : 'hidden';
  };

  const send = async () => {
    const content = text().trim();
    const id = state.selectedId;
    if (!content || id == null) return;

    if (content.startsWith('/')) {
      const m = content.match(/^\/(\w+)\s*([\s\S]*)$/);
      const cmd = m ? COMMANDS.find((c) => c.name === m[1]!.toLowerCase()) : undefined;
      if (!cmd) {
        toast(`Unknown command: ${content.split(/\s/)[0]}`);
        return;
      }
      try {
        await cmd.run(m![2]!);
        setText('');
        queueMicrotask(resize);
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err));
      }
      return;
    }

    if (streamingMessage()) return;
    setText('');
    queueMicrotask(resize);
    try {
      await api.send(id, content);
    } catch (err) {
      setText(content); // restore on failure so nothing is lost
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  const stop = () => {
    const msg = streamingMessage();
    if (msg) void api.stopGeneration(msg.id).catch(() => {});
  };

  // Resume = continue the last assistant reply in place (prefill-style).
  const resumable = () => {
    const path = activePath();
    const last = path[path.length - 1];
    return last && last.role === 'assistant' && last.status !== 'streaming' && last.content
      ? last
      : null;
  };

  const resume = () => {
    const msg = resumable();
    if (msg)
      void api
        .resume(msg.id)
        .catch((err) => toast(err instanceof Error ? err.message : String(err)));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const matches = cmdMatches();
    if (matches.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const dir = event.key === 'ArrowDown' ? 1 : -1;
        setSelIdx((i) => (i + dir + matches.length) % matches.length);
        return;
      }
      if (event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault();
        complete(matches[Math.min(selIdx(), matches.length - 1)]!);
        return;
      }
    }
    // Desktop: Enter sends, Shift+Enter newline. Touch: Enter is newline, use the button.
    if (event.key === 'Enter' && !event.shiftKey && !coarsePointer) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <Show when={state.selectedId != null}>
      <div class="composer">
        <Show when={cmdMatches().length > 0}>
          <div class="cmd-menu">
            <For each={cmdMatches()}>
              {(cmd, i) => (
                <button
                  class="cmd-item"
                  classList={{ active: i() === selIdx() }}
                  onClick={() => complete(cmd)}
                >
                  <span class="cmd-name">/{cmd.name}</span>
                  <span class="cmd-params">{cmd.params}</span>
                  <span class="cmd-desc">{cmd.description}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
        <Show when={activeCmd()}>
          {(cmd) => (
            <div class="cmd-menu cmd-hint">
              <span class="cmd-name">/{cmd().name}</span>
              <span class="cmd-params">{cmd().params}</span>
              <span class="cmd-desc">{cmd().description}</span>
            </div>
          )}
        </Show>
        <textarea
          ref={area}
          class="composer-input"
          rows="1"
          placeholder="Type a message or / for commands…"
          value={text()}
          onInput={(e) => {
            setText(e.currentTarget.value);
            resize();
          }}
          onKeyDown={onKeyDown}
        />
        <Show
          when={!streamingMessage()}
          fallback={
            <button class="send-btn stop-btn" title="Stop generating" onClick={stop}>
              <StopIcon />
            </button>
          }
        >
          <Show when={resumable()}>
            <button
              class="send-btn resume-btn"
              title="Resume last reply (assistant prefill)"
              onClick={resume}
            >
              <ResumeIcon />
            </button>
          </Show>
          <button
            class="send-btn"
            title="Send"
            disabled={!text().trim()}
            onClick={() => void send()}
          >
            <SendIcon />
          </button>
        </Show>
      </div>
    </Show>
  );
}
