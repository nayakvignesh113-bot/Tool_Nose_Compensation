# Synthesize narration per line, build timeline.json (+ captions.vtt, narration.wav)
import json, numpy as np, soundfile as sf
from kokoro_onnx import Kokoro
L = json.load(open("lesson.json"))
k = Kokoro("/home/claude/tts/kokoro-v1.0.int8.onnx", "/home/claude/tts/voices-v1.0.bin")
SR = 24000
VOICE, SPEED = "af_heart", 1.0
GAP = 0.45          # pause between lines
SCENE_PAD = 1.0     # pause at scene end
INTRO_LEAD = 1.2
CHECK = 2.2         # checkpoint card duration (player pauses here)

def sil(s): return np.zeros(int(s * SR), dtype=np.float32)

chunks, t = [sil(INTRO_LEAD)], INTRO_LEAD
tl = {"scenes": [], "checkpoints": []}
for si, sc in enumerate(L["scenes"]):
    scene = {"id": sc["id"], "title": sc["title"], "start": round(t, 3), "lines": []}
    if si > 0:  # title card lead-in
        chunks.append(sil(1.0)); t += 1.0
    for ln in sc["lines"]:
        a, sr = k.create(ln["say"], voice=VOICE, speed=SPEED, lang="en-us")
        assert sr == SR
        a = a.astype(np.float32)
        # trim leading/trailing near-silence
        nz = np.where(np.abs(a) > 0.01)[0]
        a = a[max(0, nz[0] - 600): nz[-1] + 1200]
        d = len(a) / SR
        scene["lines"].append({"start": round(t, 3), "end": round(t + d, 3), "cap": ln["cap"], "cue": ln.get("cue")})
        chunks += [a, sil(GAP)]; t += d + GAP
    chunks.append(sil(SCENE_PAD)); t += SCENE_PAD
    if sc.get("questions"):
        tl["checkpoints"].append({"t": round(t + 0.4, 3), "questions": sc["questions"], "scene": sc["id"], "rewind": scene["start"]})
        chunks.append(sil(CHECK)); t += CHECK
        scene["checkpoint"] = round(t - CHECK, 3)
    scene["end"] = round(t, 3)
    tl["scenes"].append(scene)
    print(sc["id"], round(scene["end"] - scene["start"], 1))
chunks.append(sil(3.0)); t += 3.0
tl["duration"] = round(t, 3)
audio = np.concatenate(chunks)
peak = np.max(np.abs(audio)); audio = audio / peak * 0.89
sf.write("audio/narration.wav", audio, SR)
json.dump(tl, open("timeline.json", "w"), indent=1, ensure_ascii=False)

def ts(x):
    h, r = divmod(x, 3600); m, s = divmod(r, 60)
    return f"{int(h):02d}:{int(m):02d}:{s:06.3f}"
with open("site/assets/captions.vtt", "w") as f:
    f.write("WEBVTT\n\n")
    for sc in tl["scenes"]:
        for ln in sc["lines"]:
            f.write(f"{ts(ln['start'])} --> {ts(ln['end'] + 0.3)}\n{ln['cap']}\n\n")
print("total", round(t, 1), "s")
