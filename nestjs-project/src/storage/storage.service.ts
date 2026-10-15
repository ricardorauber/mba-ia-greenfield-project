import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  type PutObjectCommandInput,
  type S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { isS3Error } from './s3-errors';
import {
  INTERNAL_GET_URL_TTL_SECONDS,
  S3_ERROR_NAMES,
  S3_INTERNAL_CLIENT,
  S3_PUBLIC_CLIENT,
} from './storage.constants';

export interface UploadedPart {
  partNumber: number;
  size: number;
  etag: string;
}

export interface PresignedUrl {
  url: string;
  expiresIn: number;
}

export interface PresignGetOptions {
  responseContentDisposition?: string;
}

@Injectable()
export class StorageService implements OnModuleDestroy {
  private readonly bucket: string;

  constructor(
    @Inject(S3_INTERNAL_CLIENT) private readonly internalClient: S3Client,
    @Inject(S3_PUBLIC_CLIENT) private readonly publicClient: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = config.bucket;
  }

  onModuleDestroy(): void {
    this.internalClient.destroy();
    this.publicClient.destroy();
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const { UploadId } = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    return UploadId!;
  }

  /** Parts already stored, ascending; `null` when the upload no longer exists. */
  async listParts(
    key: string,
    uploadId: string,
  ): Promise<UploadedPart[] | null> {
    const parts: UploadedPart[] = [];
    let partNumberMarker: string | undefined;

    try {
      let isTruncated = true;
      while (isTruncated) {
        const page = await this.internalClient.send(
          new ListPartsCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumberMarker: partNumberMarker,
          }),
        );
        for (const part of page.Parts ?? []) {
          parts.push({
            partNumber: part.PartNumber!,
            size: part.Size!,
            etag: part.ETag!,
          });
        }
        isTruncated = page.IsTruncated === true;
        partNumberMarker = page.NextPartNumberMarker;
      }
    } catch (err) {
      if (isS3Error(err, S3_ERROR_NAMES.NO_SUCH_UPLOAD)) {
        return null;
      }
      throw err;
    }

    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: Pick<UploadedPart, 'partNumber' | 'etag'>[],
  ): Promise<void> {
    await this.internalClient.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [...parts]
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
        },
      }),
    );
  }

  /** Idempotent: an upload that is already gone counts as aborted. */
  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.internalClient.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (err) {
      if (!isS3Error(err, S3_ERROR_NAMES.NO_SUCH_UPLOAD)) {
        throw err;
      }
    }
  }

  async headObject(key: string): Promise<{ contentLength: number } | null> {
    try {
      const { ContentLength } = await this.internalClient.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return { contentLength: ContentLength ?? 0 };
    } catch (err) {
      if (
        isS3Error(err, S3_ERROR_NAMES.NOT_FOUND, S3_ERROR_NAMES.NO_SUCH_KEY)
      ) {
        return null;
      }
      throw err;
    }
  }

  async putObject(
    key: string,
    body: PutObjectCommandInput['Body'],
    contentType: string,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.internalClient.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async deletePrefix(prefix: string): Promise<void> {
    let continuationToken: string | undefined;

    do {
      const page = await this.internalClient.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      const objects = (page.Contents ?? []).map((object) => ({
        Key: object.Key!,
      }));
      if (objects.length > 0) {
        await this.internalClient.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: objects, Quiet: true },
          }),
        );
      }
      continuationToken = page.IsTruncated
        ? page.NextContinuationToken
        : undefined;
    } while (continuationToken);
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<PresignedUrl> {
    const expiresIn = this.config.uploadPartUrlTtlSeconds;
    const url = await getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn },
    );
    return { url, expiresIn };
  }

  async presignGet(
    key: string,
    options: PresignGetOptions = {},
  ): Promise<PresignedUrl> {
    const expiresIn = this.config.deliveryUrlTtlSeconds;
    const url = await getSignedUrl(
      this.publicClient,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: options.responseContentDisposition,
      }),
      { expiresIn },
    );
    return { url, expiresIn };
  }

  /** Read URL for server-side consumers (ffprobe/ffmpeg) inside the Compose network. */
  async presignInternalGet(
    key: string,
    expiresIn: number = INTERNAL_GET_URL_TTL_SECONDS,
  ): Promise<string> {
    return getSignedUrl(
      this.internalClient,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn },
    );
  }
}
