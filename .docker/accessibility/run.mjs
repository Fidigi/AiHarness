import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { commandStatus } from './evidence.mjs';

const root = '/tmp/desktop-accessibility';
function completed(child) {
  return new Promise(resolve => {
    child.once('error', error => resolve({ code: null, signal: null, spawnErrorCode: error.code }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}
const packages = ['chromium', 'orca', 'at-spi2-core', 'speech-dispatcher', 'speech-dispatcher-espeak-ng',
  'libespeak-ng1', 'xvfb', 'pulseaudio', 'xdotool', 'openbox', 'scrot'];
await writeFile(`${root}/versions.json`, JSON.stringify({ node: process.version,
  npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
  playwright: JSON.parse(await readFile('/app/node_modules/playwright/package.json')).version,
  packages: execFileSync('dpkg-query', ['-W', '-f=${binary:Package}\t${Version}\n', ...packages], { encoding: 'utf8' }),
}, null, 2));
const types = await completed(spawn(process.execPath, ['scripts/run-typescript.mjs', '--noEmit', '-p', 'tests/desktop-accessibility/tsconfig.json'], { stdio: 'inherit' }));
const controls = commandStatus(types) === 0
  ? await completed(spawn(process.execPath, ['--no-maglev', '--test', '.docker/accessibility/evidence.test.mjs'], { stdio: 'inherit' }))
  : undefined;
let browser, audio;
if (controls && commandStatus(controls) === 0) {
  const recorder = spawn('parec', ['--device=review_sink.monitor', '--file-format=wav', '--format=s16le',
    '--rate=22050', '--channels=1', `${root}/reader.wav`], { stdio: ['ignore', 'inherit', 'inherit'] });
  const recording = completed(recorder);
  browser = await completed(spawn(process.execPath, ['--no-maglev', 'node_modules/@playwright/test/cli.js', 'test',
    '--config=tests/desktop-accessibility/playwright.config.ts'], { stdio: 'inherit' }));
  recorder.kill('SIGINT'); // Intentional recorder stop; not a browser/native test termination.
  const recorderExit = await recording;
  try {
    const summary = JSON.parse(execFileSync('/usr/bin/python3', ['-c',
      'import array,json,wave; w=wave.open("/tmp/desktop-accessibility/reader.wav","rb"); a=array.array("h",w.readframes(w.getnframes())); print(json.dumps({"frames":w.getnframes(),"sampleRate":w.getframerate(),"channels":w.getnchannels(),"nonzeroSamples":sum(x!=0 for x in a)}))',
    ], { encoding: 'utf8' }));
    audio = { ...summary, recorderExit, controlledStop: true, ok: summary.nonzeroSamples > 0 };
  } catch {
    audio = { recorderExit, controlledStop: true, ok: false };
  }
}
const status = commandStatus(types) || (controls ? commandStatus(controls) : 1)
  || (browser ? commandStatus(browser) : 1) || (audio?.ok ? 0 : 1);
await writeFile(`${root}/run-result.json`, JSON.stringify({ types, controls, browser, audio, status,
  // A passing case summary cannot override a nonzero command disposition.
  scope: 'Automated Linux Chromium/Orca only; not human usability or NVDA/VoiceOver qualification',
}, null, 2));
process.exitCode = status;
