import { route, HttpError } from '../router.ts';
import type { Ctx } from '../router.ts';
import { getActivePath } from '../tree.ts';
import { buildChatMessages } from '../prompt.ts';
import { buildDraftCompletionMessages, DraftSuffixFilter } from '../draftCompletionPrompt.ts';
import { hasForegroundGeneration, streamChatCompletion } from '../generation.ts';
import { requireExpectedActiveLeaf } from '../concurrency.ts';
import { objectBody, optionalNullableId, optionalNumber, positiveId } from '../validation.ts';
import { getConversation } from './conversations.ts';

const DRAFT_COMPLETION_MAX_TOKENS = 1024;
const streaming = new Set<number>();

async function completeDraft(ctx: Ctx): Promise<void> {
  const conversationId = positiveId(ctx.params.id);
  const body = objectBody(ctx.body);
  const draft = body.draft;
  if (typeof draft !== 'string' || !draft.trim()) throw new HttpError(400, 'draft is required');
  const expectedActiveLeafId = optionalNullableId(body, 'expectedActiveLeafId');
  const expectedMutationRevision = optionalNumber(body, 'expectedMutationRevision');
  requireExpectedActiveLeaf(conversationId, expectedActiveLeafId, expectedMutationRevision);
  if (hasForegroundGeneration(conversationId)) {
    throw new HttpError(409, 'a generation is already running in this conversation');
  }
  if (streaming.has(conversationId)) {
    throw new HttpError(409, 'a draft completion is already running in this conversation');
  }

  const conversation = getConversation(conversationId);
  const built = buildChatMessages(conversation, getActivePath(conversationId));
  const messages = buildDraftCompletionMessages(built.messages, draft);
  const abort = new AbortController();
  const onClose = () => {
    if (!ctx.res.writableEnded) abort.abort();
  };
  ctx.res.on('close', onClose);
  if (ctx.res.destroyed) abort.abort();
  streaming.add(conversationId);
  try {
    ctx.res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    try {
      const suffix = new DraftSuffixFilter(draft);
      await streamChatCompletion(
        conversation,
        messages,
        DRAFT_COMPLETION_MAX_TOKENS,
        (delta) => {
          const output = suffix.push(delta);
          if (output) ctx.res.write(`data: ${JSON.stringify({ d: output })}\n\n`);
        },
        abort.signal,
      );
      // The completion is based on a snapshot of the active path. If another
      // tab changed that path while the model was working, make the client
      // discard all streamed suffix text instead of keeping a stale result.
      requireExpectedActiveLeaf(conversationId, expectedActiveLeafId, expectedMutationRevision);
      const tail = suffix.finish();
      if (tail) ctx.res.write(`data: ${JSON.stringify({ d: tail })}\n\n`);
      if (!abort.signal.aborted) ctx.res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    } catch (err) {
      if (!abort.signal.aborted) {
        ctx.res.write(
          `data: ${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n\n`,
        );
      }
    }
    ctx.res.end();
  } finally {
    ctx.res.off('close', onClose);
    streaming.delete(conversationId);
  }
}

route.post('/api/conversations/:id/complete-draft', completeDraft);
