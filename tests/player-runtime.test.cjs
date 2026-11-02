const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const runtimePath = path.join(__dirname, '../lib/player-runtime.ts');
function loadRuntime() {
  const compiled = ts.transpileModule(fs.readFileSync(runtimePath, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} }; new Function('module', 'exports', compiled)(module, module.exports); return module.exports;
}
const runtime = loadRuntime();

function playRequester(onError) {
  return runtime.createPlaybackRequester(onError);
}
test('a superseded play rejection cannot report an error for the newly playing episode', async () => {
  const errors=[];const requester=playRequester(error=>errors.push(error));let rejectOld;
  const old=requester.play({play:()=>new Promise((_,reject)=>rejectOld=reject)});
  await requester.play({play:()=>Promise.resolve()});
  rejectOld(new Error('old source failed'));await old;
  assert.equal(errors.length,0);
});
test('an interrupted play is not a playback failure', async () => {
  const errors=[];const requester=playRequester(error=>errors.push(error));
  await requester.play({play:()=>Promise.reject(new DOMException('Interrupted','AbortError'))});
  assert.equal(errors.length,0);
});
test('pausing or the sleep timer cancels ownership of an unfinished play promise', async () => {
  const errors=[];const requester=playRequester(error=>errors.push(error));let reject;
  const pending=requester.play({play:()=>new Promise((_,fail)=>reject=fail)});
  requester.cancel();reject(new Error('old pending play failed'));await pending;
  assert.equal(errors.length,0);
});
test('a real failure of the active play request still surfaces to the user', async () => {
  const errors=[];const requester=playRequester(error=>errors.push(error));
  const error=new Error('Network failure');
  await requester.play({play:()=>Promise.reject(error)});
  assert.deepEqual(errors,[error]);
});
test('progress saves after seeking backwards, based on elapsed wall time', () => {
  let now = 10000; const saved = [];
  const save = runtime.createProgressSaver((...args) => saved.push(args), () => now);
  save({ currentTime: 1800, duration: 3600 }, 'one'); now += 5000;
  save({ currentTime: 600, duration: 3600 }, 'one');
  assert.equal(saved.at(-1)[1], 600);
});
test('a forced pause save also works at the beginning of an episode', () => {
  const saved=[]; const save=runtime.createProgressSaver((...args)=>saved.push(args));
  save({currentTime:0,duration:3600},'one',true);
  assert.deepEqual(saved,[['one',0,3600]]);
});
test('a superseded subtitle response can never replace the current episode', async () => {
  const pending={}; const loader=runtime.createTranscriptLoader(url=>new Promise(resolve=>pending[url]=resolve));
  const a=loader.load('A'),b=loader.load('B');
  pending['/data/transcripts/B.json']({ok:true,json:async()=>({segments:[{ko:'B'}]})});
  assert.equal((await b).segments[0].ko,'B');
  pending['/data/transcripts/A.json']({ok:true,json:async()=>({segments:[{ko:'A'}]})});
  assert.equal(await a,null);
});
test('sleep timer uses its deadline even after background callbacks are delayed', () => {
  assert.equal(runtime.remainingTimerSeconds(60000,0),60);
  assert.equal(runtime.remainingTimerSeconds(60000,61000),0);
});
test('the player saves progress from background audio events, including pause and seek', () => {
  const page=fs.readFileSync(path.join(__dirname,'../app/page.tsx'),'utf8');
  const functionSource=/function ensureAudio\(\): HTMLAudioElement \{[\s\S]*?\n  \}/.exec(page)[0].replace('(): HTMLAudioElement','()');
  const handlers={},saved=[];
  const audio={currentTime:1800,duration:3600,paused:false,addEventListener:(event,fn)=>{handlers[event]=fn}};
  const saver=runtime.createProgressSaver((...args)=>saved.push(args));
  const dependencies={playerRef:{current:null},audioElRef:{current:audio},setPlaying(){},persistCurrent(force){saver(audio,'abcdefghijk',force)},syncNow:async()=>{},checkTimer(){},setPlaybackError(){},currentIdRef:{current:'abcdefghijk'},saveProgress(){},stopAfterCurrentRef:{current:false},setStopAfterCurrent(){},videosRef:{current:[]},playFnRef:{current(){}},savedPosRef:{current:0}};
  new Function(...Object.keys(dependencies),`return (${functionSource})()`)(...Object.values(dependencies));
  handlers.timeupdate(); audio.currentTime=1900;audio.paused=true;handlers.pause();audio.currentTime=600;handlers.seeked();
  assert.deepEqual(saved.map(item=>item[1]),[1800,1900,600]);
});

test('an ended event at the sleep deadline cannot start the next episode', () => {
  const page=fs.readFileSync(path.join(__dirname,'../app/page.tsx'),'utf8');
  const ensure=/function ensureAudio\(\): HTMLAudioElement \{[\s\S]*?\n  \}/.exec(page)[0].replace('(): HTMLAudioElement','()');
  const timer=/function checkTimer\(\) \{[\s\S]*?\n  \}/.exec(page)[0];
  const handlers={};let next=0;
  const audio={currentTime:3600,duration:3600,paused:true,pause(){},addEventListener:(event,fn)=>handlers[event]=fn};
  const dependencies={playerRef:{current:null},audioElRef:{current:audio},setPlaying(){},persistCurrent(){},syncNow:async()=>{},setPlaybackError(){},currentIdRef:{current:'A'},saveProgress(){},stopAfterCurrentRef:{current:false},setStopAfterCurrent(){},videosRef:{current:[{id:'A'},{id:'B'}]},playFnRef:{current(){next++}},savedPosRef:{current:0},deadlineRef:{current:Date.now()-1},timerRef:{current:null},blockAutoAdvanceRef:{current:false},playbackRequesterRef:{current:{cancel(){}}},setTimeLeft(){},setTimerMinutes(){},remainingTimerSeconds:runtime.remainingTimerSeconds};
  const component=new Function(...Object.keys(dependencies),`${ensure};${timer};return {ensureAudio,checkTimer}`)(...Object.values(dependencies));
  component.ensureAudio();handlers.ended();
  // Some browsers queue another ended notification after the timer callback.
  component.checkTimer();handlers.ended();
  assert.equal(next,0);
});
