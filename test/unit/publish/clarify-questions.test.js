const {
  getClarifyQuestions,
  QUESTIONS,
  MULTI_SOURCE_QUESTIONS,
  DEFAULT_QUESTIONS,
} = require('../../../src/publish/clarify-questions');

describe('getClarifyQuestions', () => {
  it('returns QUESTIONS.YouTube for ["YouTube"]', () => {
    expect(getClarifyQuestions(['YouTube'])).toEqual(QUESTIONS.YouTube);
  });

  it('returns QUESTIONS.Post for ["Post"]', () => {
    expect(getClarifyQuestions(['Post'])).toEqual(QUESTIONS.Post);
  });

  it('returns QUESTIONS.Idea for ["Idea"]', () => {
    expect(getClarifyQuestions(['Idea'])).toEqual(QUESTIONS.Idea);
  });

  it('returns QUESTIONS.Audio for ["Audio"]', () => {
    expect(getClarifyQuestions(['Audio'])).toEqual(QUESTIONS.Audio);
  });

  it('returns QUESTIONS.Video for ["Video"]', () => {
    expect(getClarifyQuestions(['Video'])).toEqual(QUESTIONS.Video);
  });

  it('returns DEFAULT_QUESTIONS for unknown type', () => {
    expect(getClarifyQuestions(['UnknownType'])).toEqual(DEFAULT_QUESTIONS);
  });

  it('returns DEFAULT_QUESTIONS for empty array', () => {
    expect(getClarifyQuestions([])).toEqual(DEFAULT_QUESTIONS);
  });

  it('returns DEFAULT_QUESTIONS for null', () => {
    expect(getClarifyQuestions(null)).toEqual(DEFAULT_QUESTIONS);
  });

  it('returns DEFAULT_QUESTIONS for undefined', () => {
    expect(getClarifyQuestions(undefined)).toEqual(DEFAULT_QUESTIONS);
  });

  it('returns MULTI_SOURCE_QUESTIONS for multiple sources', () => {
    expect(getClarifyQuestions(['YouTube', 'Post'])).toEqual(MULTI_SOURCE_QUESTIONS);
  });
});

describe('result invariants', () => {
  const allInputs = [
    ['YouTube'],
    ['Post'],
    ['Idea'],
    ['Audio'],
    ['Video'],
    ['UnknownType'],
    [],
    null,
    undefined,
    ['YouTube', 'Post'],
    ['Idea', 'Audio', 'Video'],
  ];

  it.each(allInputs)('always returns exactly 3 questions for input: %j', (input) => {
    const result = getClarifyQuestions(input);
    expect(result).toHaveLength(3);
  });

  it.each(allInputs)('all questions are non-empty strings for input: %j', (input) => {
    const result = getClarifyQuestions(input);
    for (const q of result) {
      expect(typeof q).toBe('string');
      expect(q.length).toBeGreaterThan(0);
    }
  });
});

describe('exported constants', () => {
  it('QUESTIONS has entries for YouTube, Post, Idea, Audio, Video', () => {
    expect(Object.keys(QUESTIONS)).toEqual(
      expect.arrayContaining(['YouTube', 'Post', 'Idea', 'Audio', 'Video'])
    );
  });

  it('each QUESTIONS entry has exactly 3 questions', () => {
    for (const key of Object.keys(QUESTIONS)) {
      expect(QUESTIONS[key]).toHaveLength(3);
    }
  });

  it('MULTI_SOURCE_QUESTIONS has exactly 3 questions', () => {
    expect(MULTI_SOURCE_QUESTIONS).toHaveLength(3);
  });

  it('DEFAULT_QUESTIONS has exactly 3 questions', () => {
    expect(DEFAULT_QUESTIONS).toHaveLength(3);
  });
});
