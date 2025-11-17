import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, UserForbiddenError } from "./errors";
import path from "path";
import { randomBytes } from "crypto";

type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
};

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const formData = await req.formData();
  const file = formData.get("thumbnail");
  if (!(file instanceof File)) {
    throw new BadRequestError("Thumbnail file missing");
  }
  const MAX_UPLOAD_SIZE = 10 << 20;
  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError(`File is too large. Max size is 10Mb. File size is ${file.size}`);
  }
  const mediaType = file.type;
  if (mediaType !== "image/jpeg" && mediaType !== "image/png") {
    throw new BadRequestError("Only jpeg and png images are accepted as thumbnails");
  }

  const imageData = await file.arrayBuffer();
  const randomStringName = randomBytes(32).toString("base64url");
  const assetName = `${randomStringName}.${mediaType}`;
  const dataURL = path.join(cfg.assetsRoot, assetName);
  await Bun.write(dataURL, imageData);

  const videoMetaData = getVideo(cfg.db, videoId);
  if (!videoMetaData) {
    throw new BadRequestError(`Could not find video with id ${videoId}`)
  }
  if (videoMetaData.userID !== userID) {
    throw new UserForbiddenError("User logged in is not the owner of the requested video")
  }

  const thumbnailUrl = `http://localhost:${cfg.port}/assets/${assetName}`;

  videoMetaData.thumbnailURL = thumbnailUrl;
  updateVideo(cfg.db, videoMetaData)
  return respondWithJSON(200, videoMetaData);
}
