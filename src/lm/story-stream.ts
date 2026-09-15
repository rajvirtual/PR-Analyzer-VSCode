import type { ChangedFile } from "../model/changeset.js";
import { parseStory, type StorySection } from "./story-prompt.js";

/**
 * Sections of a read-through as they finish, rather than when the whole reply does.
 *
 * A section is only settled once the next one has started, so the text handed to the
 * parser never ends mid-section. The parser itself is the same one that reads the
 * finished reply — reusing it is what keeps the streamed render and the final render
 * the same document rather than two dialects of it.
 */
export interface StoryDelta {
  /** Present once, the first time the summary is known. */
  summary?: string;
  sections: StorySection[];
}

/** A heading, or one of the labelled blocks, either of which ends the section before it. */
const BOUNDARY = "^[ \\t]*(?:##[ \\t]+|(?:summary|before|after)[ \\t]*:)";

export class StoryStream {
  private buffer = "";
  private emitted = 0;
  private summarySent = false;

  constructor(private readonly files: ChangedFile[]) {}

  /** What became readable with this delta. Empty until a section finishes. */
  push(delta: string): StoryDelta {
    this.buffer += delta;

    const settled = this.settledPrefix();
    if (!settled) return { sections: [] };

    const story = parseStory(settled, this.files);
    if (!story) return { sections: [] };

    const sections = story.sections.slice(this.emitted);
    this.emitted = story.sections.length;

    const summary = !this.summarySent && story.summary ? story.summary : undefined;
    if (summary) this.summarySent = true;

    return { summary, sections };
  }

  /** Everything up to the last boundary; the text after it is still being written. */
  private settledPrefix(): string {
    const boundary = new RegExp(BOUNDARY, "gim");
    let last = -1;
    for (const match of this.buffer.matchAll(boundary)) {
      if (match.index !== undefined) last = match.index;
    }
    return last > 0 ? this.buffer.slice(0, last) : "";
  }
}
