/**
 * The knowledge seam — what it means to "be a source of knowledge".
 *
 * This is the harness thesis pointed at a second black box. A transport exists because a backend that
 * cannot do something returns 200 OK and says nothing; a KNOWLEDGE source has the same disease in a
 * worse form. Ask it about a topic it has no grounding for and it does not tell you — it returns a
 * fluent, confident, plausible answer. "It knows X" and "it is confabulating about X" are the same
 * bytes. So the harness never trusts a source either: it probes it (see `coverage.ts`) and reports
 * what it finds out loud.
 *
 * The seam is deliberately minimal and sits ABOVE `Llm`, composing it. The one thing every source
 * can do — a bare model, a RAG index, an MCP tool, an agent, a skill — is answer a question. Some
 * future source will also expose the evidence it used; that field is intentionally NOT here yet,
 * because with only the bare-model adapter it would always be empty, and this repo does not ship a
 * type nothing populates. It arrives with the first source that fills it and the check that reads it.
 */
import { defaultProfile, type SubjectProfile } from "../../profile/profile";
import type { Llm } from "../../runtime/types";

export interface KnowledgeAnswer {
  /** What the source said. */
  text: string;
  /**
   * The source's OWN signal that it had nothing — e.g. a retriever that found no documents, or an
   * MCP lookup that 404'd. This is a judge-free gap signal, so a source that can report it should.
   *
   * A bare model cannot report it: it always says *something*, and whether that something is a
   * refusal is a semantic judgment. So `createModelKnowledgeSource` leaves this `false` and the
   * probe operations classify refusal from the prose via the judge. Do not read `refused === false`
   * as "the source answered" — read it as "the source did not explicitly abstain".
   */
  refused: boolean;
}

/**
 * A source of knowledge. The whole seam.
 *
 * `signal` is a second parameter, not a field, for the same reason it is on `Llm`: an answer is data
 * you may want to log and replay, and an `AbortSignal` does not survive `JSON.stringify`.
 */
export interface KnowledgeSource {
  answer(question: string, signal?: AbortSignal): Promise<KnowledgeAnswer>;
}

/**
 * The first concrete source: the bare model's own parametric knowledge, reached through the `Llm`
 * seam. Running `coverage` against it answers "what does the naked model actually know about the
 * subject, and where does it make things up" — and it is the baseline every future retrieval source
 * (RAG, MCP, agents) is measured against. Those implement this same interface; the probe operations
 * above them do not change.
 *
 * The `profile` supplies the answering framing — critically, the PERMISSION TO ABSTAIN that makes a
 * canary meaningful. Omit it and a neutral default is used; a KB names its real subject in the
 * manifest, and a front-end passes `defaultProfile(manifest.subject)` here.
 */
export function createModelKnowledgeSource(llm: Llm, profile: SubjectProfile = defaultProfile()): KnowledgeSource {
  return {
    async answer(question, signal) {
      const result = await llm.complete(
        {
          messages: [
            { role: "system", content: profile.sourceSystem },
            { role: "user", content: question },
          ],
        },
        signal,
      );
      // A bare model does not self-report abstention; the probe's judge decides from `text`.
      return { text: result.text, refused: false };
    },
  };
}
