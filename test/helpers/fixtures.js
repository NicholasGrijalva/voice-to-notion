/**
 * Shared test fixtures for voice-to-notion unit tests
 */

const SAMPLE_YT_METADATA = {
  id: 'dQw4w9WgXcQ',
  title: 'Rick Astley - Never Gonna Give You Up',
  fulltitle: 'Rick Astley - Never Gonna Give You Up (Official Music Video)',
  duration: 212,
  ext: 'mp3',
  uploader: 'Rick Astley',
  channel: 'RickAstleyVEVO',
  webpage_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  description: 'The official video for "Never Gonna Give You Up" by Rick Astley.',
};

const SAMPLE_FFPROBE_AUDIO_ONLY = {
  format: {
    duration: '185.5',
    size: '4500000',
    bit_rate: '192000',
  },
  streams: [
    {
      codec_type: 'audio',
      codec_name: 'mp3',
      sample_rate: '44100',
      channels: '2',
    },
  ],
};

const SAMPLE_FFPROBE_VIDEO = {
  format: {
    duration: '300.0',
    size: '50000000',
    bit_rate: '1500000',
  },
  streams: [
    {
      codec_type: 'video',
      codec_name: 'h264',
    },
    {
      codec_type: 'audio',
      codec_name: 'aac',
      sample_rate: '48000',
      channels: '2',
    },
  ],
};

const SAMPLE_VTT_CONTENT = `WEBVTT
Kind: captions
Language: en

00:00:00.000 --> 00:00:02.500
Hello world

00:00:02.500 --> 00:00:05.000
This is a <b>test</b> transcript

00:00:05.000 --> 00:00:07.500
Hello world

00:00:07.500 --> 00:00:10.000
With some duplicate lines`;

const SAMPLE_SRT_CONTENT = `1
00:00:00,000 --> 00:00:02,500
Hello world

2
00:00:02,500 --> 00:00:05,000
This is a test transcript

3
00:00:05,000 --> 00:00:07,500
Final line of transcript`;

const SAMPLE_SCRIBERR_JOB = {
  id: 'job-123',
  filename: 'interview_recording.mp3',
  status: 'completed',
  duration: 3600,
  language: 'en',
  source_url: null,
  processing_time: 45,
};

const SAMPLE_SCRIBERR_TRANSCRIPT = {
  transcript: {
    text: 'This is a sample transcript from the Scriberr transcription service.',
    language: 'en',
  },
};

const SAMPLE_NOTION_PAGE_RESPONSE = {
  data: {
    id: 'page-abc-123-def-456',
    object: 'page',
    url: 'https://www.notion.so/page-abc123def456',
  },
};

const SAMPLE_NOTION_FILE_UPLOAD_RESPONSE = {
  data: {
    id: 'file-upload-789',
    status: 'uploaded',
    upload_url: 'https://s3.us-west-2.amazonaws.com/notion-uploads/abc123',
  },
};

const SAMPLE_GROQ_RESPONSE = {
  data: {
    text: 'This is a Groq-transcribed audio file content.',
    language: 'en',
    duration: 120.5,
  },
};

module.exports = {
  SAMPLE_YT_METADATA,
  SAMPLE_FFPROBE_AUDIO_ONLY,
  SAMPLE_FFPROBE_VIDEO,
  SAMPLE_VTT_CONTENT,
  SAMPLE_SRT_CONTENT,
  SAMPLE_SCRIBERR_JOB,
  SAMPLE_SCRIBERR_TRANSCRIPT,
  SAMPLE_NOTION_PAGE_RESPONSE,
  SAMPLE_NOTION_FILE_UPLOAD_RESPONSE,
  SAMPLE_GROQ_RESPONSE,
};
