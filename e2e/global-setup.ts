import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const FIXTURES = path.join(__dirname, "fixtures");

export default async function globalSetup() {
  fs.mkdirSync(FIXTURES, { recursive: true });

  // 5-second test video with audio
  if (!fs.existsSync(path.join(FIXTURES, "test-5s.mp4"))) {
    execSync(
      `ffmpeg -y -f lavfi -i testsrc=duration=5:size=320x240:rate=30 -f lavfi -i sine=frequency=440:duration=5 -c:v libx264 -c:a aac -shortest "${path.join(FIXTURES, "test-5s.mp4")}"`,
      { stdio: "pipe" },
    );
  }

  // 3-second test video (red, different tone)
  if (!fs.existsSync(path.join(FIXTURES, "test-3s.mp4"))) {
    execSync(
      `ffmpeg -y -f lavfi -i color=c=red:s=320x240:d=3:r=30 -f lavfi -i sine=frequency=880:duration=3 -c:v libx264 -c:a aac -shortest "${path.join(FIXTURES, "test-3s.mp4")}"`,
      { stdio: "pipe" },
    );
  }

  // 1-second minimal video
  if (!fs.existsSync(path.join(FIXTURES, "test-1s.mp4"))) {
    execSync(
      `ffmpeg -y -f lavfi -i color=c=blue:s=320x240:d=1:r=30 -c:v libx264 "${path.join(FIXTURES, "test-1s.mp4")}"`,
      { stdio: "pipe" },
    );
  }

  // Non-video file for rejection test
  fs.writeFileSync(path.join(FIXTURES, "test.txt"), "not a video");
}
