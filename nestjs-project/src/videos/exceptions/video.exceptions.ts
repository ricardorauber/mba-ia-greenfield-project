import { DomainException } from '../../common/exceptions/domain.exception';

export class UnsupportedVideoFormatException extends DomainException {
  constructor() {
    super(
      'UNSUPPORTED_VIDEO_FORMAT',
      400,
      'Only MP4 and WebM videos are supported',
    );
  }
}

export class VideoTooLargeException extends DomainException {
  constructor() {
    super('VIDEO_TOO_LARGE', 400, 'Video exceeds the 10 GiB size limit');
  }
}

export class InvalidPartNumberException extends DomainException {
  constructor() {
    super(
      'INVALID_PART_NUMBER',
      400,
      'Part number is out of range for this upload',
    );
  }
}

export class ChannelNotFoundException extends DomainException {
  constructor() {
    super(
      'CHANNEL_NOT_FOUND',
      404,
      'Channel not found for the authenticated user',
    );
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class InvalidVideoStatusException extends DomainException {
  constructor() {
    super(
      'INVALID_VIDEO_STATUS',
      409,
      'Video is not in a valid status for this operation',
    );
  }
}

export class UploadIncompleteException extends DomainException {
  constructor() {
    super('UPLOAD_INCOMPLETE', 409, 'Upload is missing parts');
  }
}

export class UploadSizeMismatchException extends DomainException {
  constructor() {
    super(
      'UPLOAD_SIZE_MISMATCH',
      409,
      'Uploaded file size does not match the declared size',
    );
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready');
  }
}
