// server.js — обновлённый с улучшенными субтитрами и исправленным createMasterAudio
import express from 'express';
import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import editly from 'editly';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());

const supabaseUrl = process.env.SUPABASE_URL || 'https://qpwsccpzxohrtvjrrncq.supabase.co';
const supabaseKey = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFwd3NjY3B6eG9ocnR2anJybmNxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0Nzc1OTE4NSwiZXhwIjoyMDYzMzM1MTg1fQ.bCGkuo-VM0w_J7O0-tDeZ_hCTr6VxqvR8ARUjgZz9UQ';

const JOBS = new Map();
const JOB_LOGS = new Map();

const logToJob = (jobId, message, type = 'info') => {
  if (!JOB_LOGS.has(jobId)) JOB_LOGS.set(jobId, []);
  JOB_LOGS.get(jobId).push({ timestamp: new Date().toISOString(), type, message });
  const logs = JOB_LOGS.get(jobId);
  if (logs.length > 100) logs.splice(0, logs.length - 100);
  console.log(`[${jobId.slice(-8)}] ${message}`);
};

const getAudioDuration = async (audioPath) => {
  try {
    const { stdout } = await execAsync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${audioPath}"`);
    return parseFloat(stdout.trim());
  } catch (error) {
    return 4.0;
  }
};

const createMasterAudio = async (requestId, clips, jobId) => {
  try {
    const masterAudioPath = path.join('media', requestId, 'audio', 'master.wav');
    const musicPath = path.join('media', requestId, 'audio', 'music.mp3');

    let hasMusic = false;
    try {
      await fs.access(musicPath);
      hasMusic = true;
      logToJob(jobId, 'Background music found');
    } catch (e) {
      logToJob(jobId, 'No background music');
    }

    const audioInputs = [];
    const filterParts = [];
    let inputIndex = 0;
    let currentTime = 0;

    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      if (clip.voiceAudio) {
        const audioDuration = await getAudioDuration(clip.voiceAudio);
        audioInputs.push(`-i "${clip.voiceAudio}"`);
        filterParts.push(`[${inputIndex}:a]volume=1.0,adelay=${Math.round(currentTime * 1000)}|${Math.round(currentTime * 1000)}[voice${inputIndex}]`);
        inputIndex++;
        currentTime += clip.duration;
      } else {
        currentTime += clip.duration;
      }
    }

    if (audioInputs.length === 0 && !hasMusic) {
      logToJob(jobId, 'No audio to process');
      return null;
    }

    const totalDuration = currentTime;
    if (hasMusic) {
      audioInputs.push(`-i "${musicPath}"`);
      filterParts.push(`[${inputIndex}:a]volume=0.2,aloop=loop=-1:size=2e+09,atrim=0:${totalDuration}[music]`);
    }

    const voiceTags = filterParts.filter(f => f.includes('voice')).map((_, i) => `[voice${i}]`).join('');
    const mixInputs = voiceTags + (hasMusic ? '[music]' : '');
    const mixCount = audioInputs.length;
    const filterComplex = filterParts.join(';') + `;${mixInputs}amix=inputs=${mixCount}:duration=longest[out]`;
    const command = `ffmpeg -y ${audioInputs.join(' ')} -filter_complex "${filterComplex}" -map "[out]" -c:a pcm_s16le -ar 44100 -ac 2 "${masterAudioPath}"`;

    logToJob(jobId, 'Creating master audio...');
    await execAsync(command);
    await fs.access(masterAudioPath);
    const stats = await fs.stat(masterAudioPath);
    logToJob(jobId, `Master audio: ${Math.round(stats.size / 1024)}KB`);
    return masterAudioPath;
  } catch (error) {
    logToJob(jobId, `Audio creation failed: ${error.message}`, 'error');
    return null;
  }
};

const ensureDirs = async (requestId) => {
  const base = path.join('media', requestId);
  await fs.mkdir(path.join(base, 'audio'), { recursive: true });
  await fs.mkdir(path.join(base, 'images'), { recursive: true });
  await fs.mkdir(path.join(base, 'text'), { recursive: true });
  await fs.mkdir(path.join(base, 'video'), { recursive: true });
};

const downloadFile = async (url, localPath, timeout = 30000) => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VideoProcessor/1.0)' }
    });

    clearTimeout(timeoutId);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const buffer = await response.buffer();
    await fs.writeFile(localPath, buffer);
    return true;
  } catch (error) {
    console.error(`Download failed: ${url}`);
    return false;
  }
};

const downloadAllFiles = async (requestId, supabaseBaseUrl, supabaseData, music, jobId) => {
  const results = { music: false, slides: [] };

  if (music) {
    logToJob(jobId, `Downloading music: ${music}`);
    const musicUrl = `${supabaseBaseUrl}${music}`;
    const musicPath = path.join('media', requestId, 'audio', 'music.mp3');
    results.music = await downloadFile(musicUrl, musicPath);
  }

  for (let i = 0; i < supabaseData.length; i++) {
    const slide = supabaseData[i];
    const slideResult = { index: i, image: false, audio: false, text: false };

    if (slide.image) {
      const imageUrl = `${supabaseBaseUrl}${slide.image}`;
      const imagePath = path.join('media', requestId, 'images', `${i}.jpg`);
      slideResult.image = await downloadFile(imageUrl, imagePath);
    }

    if (slide.audio) {
      const audioUrl = `${supabaseBaseUrl}${slide.audio}`;
      const audioPath = path.join('media', requestId, 'audio', `${i}.mp3`);
      slideResult.audio = await downloadFile(audioUrl, audioPath);

      if (slideResult.audio) {
        const wavPath = path.join('media', requestId, 'audio', `${i}.wav`);
        try {
          await execAsync(`ffmpeg -y -i "${audioPath}" -c:a pcm_s16le -ar 44100 -ac 2 "${wavPath}"`);
          await fs.unlink(audioPath);
        } catch (e) {
          logToJob(jobId, `Audio convert failed for slide ${i}`, 'error');
        }
      }
    }

    if (slide.text) {
      const textUrl = `${supabaseBaseUrl}${slide.text}`;
      const textPath = path.join('media', requestId, 'text', `${i}.json`);
      slideResult.text = await downloadFile(textUrl, textPath);
    }

    results.slides.push(slideResult);
  }

  return results;
};

const uploadVideoToSupabase = async (videoPath, requestId, jobId) => {
  const videoBuffer = await fs.readFile(videoPath);
  const fileName = `${requestId}/final.mp4`;
  const uploadUrl = `${supabaseUrl}/storage/v1/object/videos/${fileName}`;

  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type': 'video/mp4',
      'x-upsert': 'true'
    },
    body: videoBuffer
  });

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status}`);
  }

  const publicUrl = `${supabaseUrl}/storage/v1/object/public/videos/${fileName}`;
  return { success: true, path: fileName, publicUrl, size: videoBuffer.length };
};

const buildEditSpec = async (requestId, numSlides, jobId) => {
  const imageDir = path.join('media', requestId, 'images');
  const audioDir = path.join('media', requestId, 'audio');
  const textDir = path.join('media', requestId, 'text');
  const clips = [];

  for (let i = 0; i < numSlides; i++) {
    const imagePath = path.join(imageDir, `${i}.jpg`);
    const voiceAudioPath = path.join(audioDir, `${i}.wav`);
    const textPath = path.join(textDir, `${i}.json`);

    let imageExists = false;
    let voiceExists = false;

    try {
      await fs.access(imagePath);
      imageExists = true;
    } catch (e) {}

    try {
      await fs.access(voiceAudioPath);
      voiceExists = true;
    } catch (e) {}

    if (!imageExists) {
      logToJob(jobId, `Skip slide ${i} - no image`);
      continue;
    }

    let textLayer = null;
    try {
      const textData = JSON.parse(await fs.readFile(textPath, 'utf-8'));
      if (textData.text && textData.text.trim()) {
        textLayer = {
          type: 'subtitle',
          text: textData.text,
          position: 'bottom',
          margin: { bottom: 30 },
          textColor: textData.color || '#FFFFFF',
          backgroundColor: 'rgba(0, 0, 0, 0.7)',
          fontSize: textData.fontSize || 28,
          fontFamily: 'Arial',
          align: 'center',
          maxWidth: 0.9,
          wrap: true,
          padding: 10
        };
        logToJob(jobId, `Subtitle layer created for slide ${i}`);
      }
    } catch (e) {
      logToJob(jobId, `Failed to load or parse text for slide ${i}: ${e.message}`, 'error');
    }

    let clipDuration = 4;
    if (voiceExists) {
      const audioDuration = await getAudioDuration(voiceAudioPath);
      if (audioDuration > 0) {
        clipDuration = Math.max(audioDuration, 2);
      }
    }

    const layers = [{ type: 'image', path: imagePath }];
    if (textLayer) layers.push(textLayer);

    clips.push({
      layers,
      duration: clipDuration,
      voiceAudio: voiceExists ? voiceAudioPath : null
    });
  }

  if (clips.length === 0) throw new Error('No valid clips');

  const finalVideoPath = path.join('media', requestId, 'video', 'final.mp4');

  const editlySpec = {
    outPath: finalVideoPath,
    width: 1280,
    height: 720,
    fps: 30,
    clips: clips.map(clip => ({ layers: clip.layers, duration: clip.duration })),
    defaults: { transition: { name: 'fade', duration: 0.5 }, layer: { resizeMode: 'contain' } },
    keepSourceAudio: false,
    fast: false,
    enableFfmpegLog: true,
    verbose: true
  };

  logToJob(jobId, `Editly spec: ${clips.length} clips total`);
  clips.forEach((clip, index) => {
    const hasText = clip.layers.some(l => l.type === 'subtitle');
    logToJob(jobId, `Clip ${index}: duration=${clip.duration}s, layers=${clip.layers.length}, hasText=${hasText}`);
    if (hasText) {
      const sub = clip.layers.find(l => l.type === 'subtitle');
      logToJob(jobId, `  Subtitle text: "${sub.text.substring(0, 30)}..."`);
    }
  });

  return { editlySpec, clips, finalVideoPath };
};

const addAudioToVideo = async (videoPath, audioPath, outputPath, jobId) => {
  try {
    logToJob(jobId, '
