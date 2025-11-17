import { respondWithJSON } from "./json";
import { S3Client, type BunRequest } from "bun";
import { type ApiConfig } from "../config";
import { BadRequestError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import path from "path";
import { randomBytes } from "crypto";
import { unlink } from "fs/promises"

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

  //const videoData = await file.arrayBuffer();
  const randomStringName = randomBytes(32).toString("base64url");
  const assetName = `${randomStringName}.mp4`;
  let dataURL: string | undefined;
  try{
    dataURL = path.join(cfg.assetsRoot, assetName);
    await Bun.write(dataURL, file);
    const s3File = cfg.s3Client.file(assetName, {
      bucket: cfg.s3Bucket,
      region: cfg.s3Region,
      type: "video/mp4",
    });
    await s3File.write(Bun.file(dataURL));

    videoData.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${assetName}`
    updateVideo(cfg.db, videoData)
  } finally {
    if (dataURL) {
      try { await unlink(dataURL); } catch {}
    }
  }
  return respondWithJSON(200, videoData);
}
