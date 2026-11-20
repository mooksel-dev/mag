// mag-audio: captures the microphone and the system audio (Core Audio process tap, macOS 14.2+) and streams both to
// stdout as 16 kHz mono Float32 PCM frames: [1 byte channel: 0 me, 1 others][4 bytes LE sample count][samples].
// stderr gets one JSON line per event ({"event":"ready"} / {"event":"error","message":…}). Stops on stdin EOF or SIGTERM.
import AVFoundation
import CoreAudio
import Foundation

let rate = 16_000.0
let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false)!
let out = FileHandle.standardOutput
let writeQueue = DispatchQueue(label: "mag.audio.write")

func event(_ name: String, _ message: String? = nil) {
  var o: [String: String] = ["event": name]
  if let message { o["message"] = message }
  let data = try! JSONSerialization.data(withJSONObject: o)
  FileHandle.standardError.write(data + Data("\n".utf8))
}

func fail(_ message: String) -> Never {
  event("error", message)
  exit(1)
}

func emit(_ channel: UInt8, _ buffer: AVAudioPCMBuffer) {
  let n = Int(buffer.frameLength)
  guard n > 0, let p = buffer.floatChannelData?[0] else { return }
  var frame = Data([channel])
  var count = UInt32(n).littleEndian
  frame.append(Data(bytes: &count, count: 4))
  frame.append(Data(bytes: p, count: n * 4))
  writeQueue.async { out.write(frame) }
}

/** Converts whatever the source gives to 16 kHz mono and emits it on `channel`. */
final class Resampler {
  let converter: AVAudioConverter
  let channel: UInt8
  init(from: AVAudioFormat, channel: UInt8) {
    guard let c = AVAudioConverter(from: from, to: target) else { fail("cannot convert \(from) to 16 kHz mono") }
    c.downmix = true
    converter = c
    self.channel = channel
  }
  func push(_ input: AVAudioPCMBuffer) {
    let capacity = AVAudioFrameCount(Double(input.frameLength) * rate / input.format.sampleRate) + 32
    guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
    var given = false
    var error: NSError?
    converter.convert(to: output, error: &error) { _, status in
      if given { status.pointee = .noDataNow; return nil }
      given = true
      status.pointee = .haveData
      return input
    }
    if error == nil { emit(channel, output) }
  }
}

func check(_ status: OSStatus, _ what: String) {
  if status != noErr { fail("\(what) failed (OSStatus \(status))") }
}

func property<T: BitwiseCopyable>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T) -> T {
  var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var value = initial
  var size = UInt32(MemoryLayout<T>.size)
  check(AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value), "reading property \(selector)")
  return value
}

func deviceUID(_ device: AudioObjectID) -> String {
  var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceUID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var uid: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  check(AudioObjectGetPropertyData(device, &address, 0, nil, &size, &uid), "reading the output device")
  guard let uid else { fail("the output device has no UID") }
  return uid.takeRetainedValue() as String
}

// System audio: a tap of every process but ours, through a private aggregate device.
var tapID = AudioObjectID(kAudioObjectUnknown)
var aggregateID = AudioObjectID(kAudioObjectUnknown)
var procID: AudioDeviceIOProcID?

func startSystem() {
  let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
  description.uuid = UUID()
  description.muteBehavior = .unmuted
  description.isPrivate = true
  check(AudioHardwareCreateProcessTap(description, &tapID), "creating the system audio tap")
  var format = property(tapID, kAudioTapPropertyFormat, AudioStreamBasicDescription())
  guard let source = AVAudioFormat(streamDescription: &format) else { fail("unknown system audio format") }
  let outputDevice = property(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultOutputDevice, AudioObjectID(kAudioObjectUnknown))
  let outputUID = deviceUID(outputDevice)
  let aggregate: [String: Any] = [
    kAudioAggregateDeviceNameKey: "mag meeting capture",
    kAudioAggregateDeviceUIDKey: UUID().uuidString,
    kAudioAggregateDeviceMainSubDeviceKey: outputUID,
    kAudioAggregateDeviceIsPrivateKey: true,
    kAudioAggregateDeviceIsStackedKey: false,
    kAudioAggregateDeviceTapAutoStartKey: true,
    kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
    kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: description.uuid.uuidString]],
  ]
  check(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID), "creating the capture device")
  let resampler = Resampler(from: source, channel: 1)
  check(AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, nil) { _, input, _, _, _ in
    guard let buffer = AVAudioPCMBuffer(pcmFormat: source, bufferListNoCopy: input, deallocator: nil) else { return }
    resampler.push(buffer)
  }, "attaching to the capture device")
  check(AudioDeviceStart(aggregateID, procID), "starting system audio capture")
}

func stopSystem() {
  if let procID { AudioDeviceStop(aggregateID, procID); AudioDeviceDestroyIOProcID(aggregateID, procID) }
  if aggregateID != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(aggregateID) }
  if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID) }
}

// Microphone.
let engine = AVAudioEngine()

func startMic() {
  let input = engine.inputNode
  let format = input.outputFormat(forBus: 0)
  if format.sampleRate == 0 { fail("no microphone") }
  let resampler = Resampler(from: format, channel: 0)
  input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in resampler.push(buffer) }
  do { try engine.start() } catch { fail("starting the microphone: \(error.localizedDescription)") }
}

func shutdown() -> Never {
  engine.stop()
  stopSystem()
  writeQueue.sync {}
  exit(0)
}

// macOS asks the responsible app for permission; disclaimed, the helper is its own (its Info.plist names the use).
typealias Disclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
if ProcessInfo.processInfo.environment["MAG_AUDIO_DISCLAIMED"] == nil,
   let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim") {
  var attr: posix_spawnattr_t?
  posix_spawnattr_init(&attr)
  _ = unsafeBitCast(sym, to: Disclaim.self)(&attr, 1)
  setenv("MAG_AUDIO_DISCLAIMED", "1", 1)
  let path = CommandLine.arguments[0]
  var argv: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) } + [nil]
  var pid: pid_t = 0
  if posix_spawn(&pid, path, nil, &attr, &argv, environ) != 0 { fail("starting the capture helper failed") }
  let forward = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
  forward.setEventHandler { kill(pid, SIGTERM) }
  forward.resume()
  signal(SIGTERM, SIG_IGN)
  DispatchQueue.global().async {
    var status: Int32 = 0
    waitpid(pid, &status, 0)
    exit((status >> 8) & 0xff)
  }
  dispatchMain()
}

signal(SIGTERM, SIG_IGN)
signal(SIGPIPE, SIG_IGN)
let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
term.setEventHandler { shutdown() }
term.resume()
FileHandle.standardInput.readabilityHandler = { h in if h.availableData.isEmpty { DispatchQueue.main.async { shutdown() } } }

AVCaptureDevice.requestAccess(for: .audio) { granted in
  DispatchQueue.main.async {
    if !granted { fail("microphone access denied: allow mag-audio in System Settings → Privacy & Security → Microphone") }
    startSystem()
    startMic()
    event("ready")
  }
}
dispatchMain()
