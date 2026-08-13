#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <Vision/Vision.h>

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 2) return 2;
    NSString *path = [NSString stringWithUTF8String:argv[1]];
    NSURL *url = [NSURL fileURLWithPath:path];
    CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)url, NULL);
    if (!source) return 3;
    CGImageRef image = CGImageSourceCreateImageAtIndex(source, 0, NULL);
    CFRelease(source);
    if (!image) return 4;

    VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
    request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
    request.usesLanguageCorrection = YES;
    VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:image options:@{}];
    NSError *error = nil;
    BOOL ok = [handler performRequests:@[ request ] error:&error];
    CGImageRelease(image);
    if (!ok) {
      fprintf(stderr, "%s\n", error.localizedDescription.UTF8String);
      return 5;
    }

    NSMutableArray<NSString *> *lines = [NSMutableArray array];
    for (VNRecognizedTextObservation *observation in request.results) {
      VNRecognizedText *candidate = [[observation topCandidates:1] firstObject];
      if (candidate.string.length > 0) [lines addObject:candidate.string];
    }
    printf("%s\n", [lines componentsJoinedByString:@"\n"].UTF8String);
  }
  return 0;
}
