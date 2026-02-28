/**
 * Audio Extractor - ffmpeg wrapper for extracting/converting audio from video files
 * Used when we have video files that need audio extracted for transcription
 */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

class AudioExtractor {
  constructor(options = {}) {
    this.ffmpegPath = options.ffmpegPath || 'ffmpeg';
    this.ffprobePath = options.ffprobePath || 'ffprobe';
    this.outputDir = options.outputDir || '/tmp/audio-extracted';
    this.timeout = options.timeout || 300000; // 5 min default
    this.ensureDir(this.outputDir);
  }

  ensureDir(dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Extract audio from a video/media file
   *
   * @param {string} inputPath - Path to input file
   * @param {Object} opts
   * @param {string} opts.format - Output format: mp3, m4a, wav (default: mp3)
   * @param {string} opts.bitrate - Audio bitrate (default: 192k)
   * @param {boolean} opts.mono - Convert to mono (default: false)
   * @param {number} opts.sampleRate - Sample rate in Hz (default: keep original)
   * @returns {Promise<{filePath: string, filename: string, duration: number, format: string}>}
   */
  async extract(inputPath, opts = {}) {
    const {
      format = 'mp3',
      bitrate = '192k',
      mono = false,
      sampleRate = null,
      outputFilename = null
    } = opts;

    if (!fs.existsSync(inputPath)) {
      throw new Error(`Input file not found: ${inputPath}`);
    }

    const baseName = outputFilename ||
      path.basename(inputPath, path.extname(inputPath));
    const outputPath = path.join(this.outputDir, `${baseName}.${format}`);

    const args = [
      '-i', inputPath,
      '-vn',                    // No video
      '-acodec', this.getCodec(format),
      '-ab', bitrate,
      '-y',                     // Overwrite output
    ];

    if (mono) {
      args.push('-ac', '1');
    }

    if (sampleRate) {
      args.push('-ar', String(sampleRate));
    }

    args.push(outputPath);

    console.log(`[AudioExtractor] Extracting audio: ${path.basename(inputPath)} → ${path.basename(outputPath)}`);

    await this.exec(this.ffmpegPath, args);

    const fileSize = fs.statSync(outputPath).size;
    const duration = await this.getDuration(outputPath);

    console.log(`[AudioExtractor] Extracted: ${path.basename(outputPath)} (${(fileSize / 1024 / 1024).toFixed(2)} MB, ${Math.round(duration)}s)`);

    return {
      filePath: outputPath,
      filename: path.basename(outputPath),
      duration,
      format,
      fileSize,
      contentType: this.getMimeType(format)
    };
  }

  /**
   * Get duration of an audio/video file in seconds
   */
  async getDuration(filePath) {
    try {
      const args = [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        filePath
      ];

      const result = await this.exec(this.ffprobePath, args);
      const info = JSON.parse(result.stdout);
      return parseFloat(info.format?.duration || '0');
    } catch {
      return 0;
    }
  }

  /**
   * Get basic info about a media file
   */
  async getInfo(filePath) {
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ];

    const result = await this.exec(this.ffprobePath, args);
    const info = JSON.parse(result.stdout);

    const audioStream = info.streams?.find(s => s.codec_type === 'audio');
    const videoStream = info.streams?.find(s => s.codec_type === 'video');

    return {
      duration: parseFloat(info.format?.duration || '0'),
      fileSize: parseInt(info.format?.size || '0'),
      hasAudio: !!audioStream,
      hasVideo: !!videoStream,
      audioCodec: audioStream?.codec_name || null,
      videoCodec: videoStream?.codec_name || null,
      sampleRate: audioStream ? parseInt(audioStream.sample_rate) : null,
      channels: audioStream ? parseInt(audioStream.channels) : null,
      bitrate: info.format?.bit_rate ? parseInt(info.format.bit_rate) : null
    };
  }

  /**
   * Check if a file is already audio-only (no video stream)
   */
  async isAudioOnly(filePath) {
    const info = await this.getInfo(filePath);
    return info.hasAudio && !info.hasVideo;
  }

  /**
   * Convert audio to a different format (when input is already audio)
   */
  async convert(inputPath, opts = {}) {
    // Same as extract but semantically different — input is already audio
    return this.extract(inputPath, opts);
  }

  getCodec(format) {
    const codecs = {
      'mp3': 'libmp3lame',
      'm4a': 'aac',
      'wav': 'pcm_s16le',
      'ogg': 'libvorbis',
      'flac': 'flac',
      'opus': 'libopus'
    };
    return codecs[format] || 'libmp3lame';
  }

  getMimeType(format) {
    const types = {
      'mp3': 'audio/mpeg',
      'm4a': 'audio/mp4',
      'wav': 'audio/wav',
      'ogg': 'audio/ogg',
      'flac': 'audio/flac',
      'opus': 'audio/opus'
    };
    return types[format] || 'audio/mpeg';
  }

  exec(cmd, args) {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, {
        timeout: this.timeout,
        maxBuffer: 5 * 1024 * 1024
      }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${cmd} failed: ${stderr || error.message}`));
          return;
        }
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      });
    });
  }
}

module.exports = AudioExtractor;
