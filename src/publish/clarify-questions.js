/**
 * Clarify questions by content type.
 * Hardcoded -- no LLM. These prompt the USER to sharpen their thinking.
 */

const QUESTIONS = {
  YouTube: [
    "What's the one thing from this video you'd tell a friend?",
    "What did the speaker get right that most people miss?",
    "What would you push back on?",
  ],
  Post: [
    "What's the deeper point behind this post?",
    "Why does this matter beyond the timeline?",
    "What would you add that the author left out?",
  ],
  Idea: [
    "What would you say if you only had one sentence?",
    "What do most people get wrong about this?",
    "What changed for you when you realized this?",
  ],
  Audio: [
    "What were you actually trying to say?",
    "If you had to convince a skeptic, what's the strongest version?",
    "What's the tension or counterintuitive part?",
  ],
  Video: [
    "What's the one thing from this that you'd tell a friend?",
    "What did the speaker get right that most people miss?",
    "What would you push back on?",
  ],
};

const MULTI_SOURCE_QUESTIONS = [
  "What connects these ideas?",
  "What would someone DO differently after reading your post?",
  "What's the synthesis -- the thing none of these sources say alone?",
];

const DEFAULT_QUESTIONS = [
  "What's the one thing someone should take away?",
  "What would make someone stop scrolling?",
  "What would you say differently now than when you captured this?",
];

/**
 * Get clarify questions based on source content types.
 *
 * @param {string[]} sourceTypes - e.g. ['YouTube'], ['Idea', 'Post']
 * @returns {string[]} - always 3 questions
 */
function getClarifyQuestions(sourceTypes) {
  if (!sourceTypes || sourceTypes.length === 0) return DEFAULT_QUESTIONS;
  if (sourceTypes.length > 1) return MULTI_SOURCE_QUESTIONS;
  return QUESTIONS[sourceTypes[0]] || DEFAULT_QUESTIONS;
}

module.exports = { getClarifyQuestions, QUESTIONS, MULTI_SOURCE_QUESTIONS, DEFAULT_QUESTIONS };
