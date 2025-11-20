import { type BunRequest } from "bun";
import { type ApiConfig } from "../config";
import { respondWithJSON } from "./json";
import { BadRequestError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo, type Video } from "../db/videos";
import path from "path";
import { rm } from "fs/promises"

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const MAX_UPLOAD_SIZE = 1 << 30;

  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading video", videoId, "by user", userID);

  const videoData = getVideo(cfg.db, videoId);
  if (!videoData) {
    throw new BadRequestError(`Could not find video with id ${videoId}`);
  }
  if (videoData.userID !== userID) {
    throw new UserForbiddenError("User logged in is not the owner of the requested video");
  }

  const formData = await req.formData();
  const file = formData.get("video");
  if (!(file instanceof File)) {
    throw new BadRequestError("Video file missing");
  }
  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError(`File is too large. Max size is 1Gb. File size is ${file.size}`);
  }
  const mediaType = file.type;
  if (mediaType !== "video/mp4") {
    throw new BadRequestError("Only mp4 videos are accepted");
  }

  let tempFilePath: string | undefined;

  tempFilePath = path.join("./tmp", `${videoId}.mp4`);
  await Bun.write(tempFilePath, file);
  const processedURL = await processVideoForFastStart(tempFilePath)

  const s3Name = `${await getVideoAspectRatio(processedURL)}/${videoId}.mp4`;
  const s3File = cfg.s3Client.file(s3Name, {
    bucket: cfg.s3Bucket,
    region: cfg.s3Region,
    type: "video/mp4",
  });
  const procFile = Bun.file(processedURL);
  console.log(await procFile.slice(0, 100).text());
  console.log((await procFile.slice(0, 100).text()).includes("moov"));
  await s3File.write(Bun.file(processedURL));

  //videoData.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${s3Name}`;
  videoData.videoURL = `https://${cfg.s3CfDistribution}/${s3Name}`;
  updateVideo(cfg.db, videoData)
  if (processedURL) {
    try { await rm(processedURL); } catch { }
  }
  
  return respondWithJSON(200, videoData);
}
type VideoAspect = {
  streams: {
    width: number,
    height: number,
  }[]
}

async function getVideoAspectRatio(filepath: string) {
  const proc = Bun.spawn(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", filepath]);
  if (await proc.exited !== 0) {
    const errorText = await new Response(proc.stderr).text();
    throw new Error(`Could not get aspect ratio of video in ${filepath}. Error: ${errorText}`);
  }
  const result = await new Response(proc.stdout).text();
  if (!result) {
    throw new Error("No info found");
  }
  try {
    const information = JSON.parse(result) as VideoAspect;
    console.log(information.streams[0]);
    return calculateRatio(information.streams[0].width, information.streams[0].height);
  } catch (error) {
    throw new Error("Could not parse video aspect info")
  }
}

function calculateRatio(width: number, height: number) {
  console.log(`height: ${height}`)
  console.log(`width: ${width}`)
  if (height > width) {
    return ((height / width) >= 1.76 && (height / width) <= 1.78) ? "portrait" : "other";
  }
  if (height < width) {
    return ((width / height) >= 1.76 && (width / height) <= 1.78) ? "landscape" : "other";
  }
  return "other";
}

async function processVideoForFastStart(inputFilePath: string) {
  const outputPath = `${inputFilePath}.processed`;

  const proc = Bun.spawn(["ffmpeg", "-i", inputFilePath, "-movflags", "faststart", "-map_metadata", "0", "-codec", "copy", "-f", "mp4", outputPath])

  if (await proc.exited !== 0) {
    const errorText = await new Response(proc.stderr).text();
    throw new Error(`Could not process video for fast start. ${errorText}`);
  }
  return outputPath;
}