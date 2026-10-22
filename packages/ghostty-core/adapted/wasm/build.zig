const std = @import("std");

pub fn build(b: *std.Build) void {
    var target = b.standardTargetOptions(.{});
    if (target.result.cpu.arch.isWasm()) {
        var query = target.query;
        const simd = b.option(bool, "wasm-simd", "Enable WebAssembly SIMD") orelse true;
        const feature = @intFromEnum(std.Target.wasm.Feature.simd128);
        if (simd) {
            query.cpu_features_add.addFeature(feature);
        } else {
            query.cpu_features_add.removeFeature(feature);
            query.cpu_features_sub.addFeature(feature);
        }
        target = b.resolveTargetQuery(query);
    }
    const optimize = b.standardOptimizeOption(.{});

    retargetMacOS27Host(b);

    const exe_mod = b.createModule(.{
        .root_source_file = b.path("src/terax.zig"),
        .target = target,
        .optimize = optimize,
        .strip = optimize != .Debug,
    });

    const exe = b.addExecutable(.{
        .name = "terax-ghostty-vt",
        .root_module = exe_mod,
    });

    exe.entry = .disabled;
    exe.rdynamic = true;
    if (target.result.cpu.arch.isWasm()) {
        // Each terminal owns an instance, so the shadow stack is paid once per
        // terminal. The stack is placed first in linear memory: an overflow
        // traps on an out-of-bounds access instead of corrupting data.
        const stack_kib = b.option(u32, "wasm-stack-kib", "WebAssembly shadow stack size in KiB") orelse 96;
        exe.stack_size = @as(u64, stack_kib) * 1024;
    }

    const ghostty_dep = b.dependency("ghostty", .{
        .target = target,
        .optimize = optimize,
        .simd = false,
    });
    const terminfo_mod = b.createModule(.{
        .root_source_file = ghostty_dep.path("src/terminfo/main.zig"),
        .target = b.graph.host,
        .optimize = .ReleaseFast,
    });
    const terminfo_gen = b.addExecutable(.{
        .name = "terax-ghostty-terminfo-gen",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/terminfo_gen.zig"),
            .target = b.graph.host,
            .optimize = .ReleaseFast,
            .strip = true,
        }),
    });
    terminfo_gen.root_module.addImport("ghostty-terminfo", terminfo_mod);
    const terminfo_run = b.addRunArtifact(terminfo_gen);
    const generated_files = b.addWriteFiles();
    const terminfo_output = generated_files.addCopyFile(
        terminfo_run.captureStdOut(.{}),
        "terax_ghostty_terminfo.zig",
    );

    const upstream_vt = ghostty_dep.module("ghostty-vt");
    const wuffs_mod = enableKittyGraphics(ghostty_dep, upstream_vt, target, optimize);
    const vt_mod = freestandingImageMedia(b, ghostty_dep, upstream_vt);
    exe.root_module.addImport("ghostty-vt", vt_mod);
    // Null only on the first configure pass, before Zig fetches the lazy
    // package and runs the build again.
    if (wuffs_mod) |module| exe.root_module.addImport("wuffs", module);
    exe.root_module.addAnonymousImport("ghostty-terminfo-responses", .{
        .root_source_file = terminfo_output,
    });

    b.installArtifact(exe);
}

/// Turns on the Kitty graphics protocol, which Ghostty's build switches off
/// for every freestanding target ("requires timestamps"). The pinned source
/// takes no clock in that subsystem: animation time is passed in by the
/// caller and the one lock never contends in a single-threaded instance. Its
/// build decides inside the dependency's own script, so the generated option
/// is rewritten here and the wuffs import Ghostty adds only when the feature
/// is on (zlib payloads, pixel conversion) is added too. Returns wuffs, whose
/// PNG decoder the bridge registers (null until Zig has fetched it). Fails
/// the build if either has moved.
fn enableKittyGraphics(
    ghostty_dep: *std.Build.Dependency,
    vt_mod: *std.Build.Module,
    target: std.Build.ResolvedTarget,
    optimize: std.builtin.OptimizeMode,
) ?*std.Build.Module {
    const options_mod = vt_mod.import_table.get("terminal_options") orelse
        @panic("ghostty-vt no longer has terminal_options");
    const generated = options_mod.root_source_file orelse
        @panic("terminal_options has no root source");
    const options: *std.Build.Step.Options = @fieldParentPtr("step", generated.generated.file.step);
    const disabled = "pub const kitty_graphics: bool = false;";
    const index = std.mem.indexOf(u8, options.contents.items, disabled) orelse
        @panic("terminal_options no longer emits kitty_graphics = false");
    options.contents.replaceRangeAssumeCapacity(index + disabled.len - "false;".len, "false;".len, "true; ");

    const wuffs_dep = ghostty_dep.builder.lazyDependency("wuffs", .{
        .target = target,
        .optimize = optimize,
    }) orelse return null;
    const wuffs_mod = wuffs_dep.module("wuffs");
    if (vt_mod.import_table.get("wuffs") == null) vt_mod.addImport("wuffs", wuffs_mod);
    return wuffs_mod;
}

/// Ghostty's Kitty image loader (`LoadingImage.init`) instantiates its file,
/// temporary-file and shared-memory media for every target, and the file
/// path needs POSIX directory handles a freestanding target does not have.
/// This builds ghostty-vt from a copy of the pinned source whose loader
/// refuses those media on freestanding targets before reaching them (only
/// direct, in-band transmission can work in a webview anyway); the module's
/// imports (options, Unicode tables, uucode, wuffs) are the original ones.
fn freestandingImageMedia(
    b: *std.Build,
    ghostty_dep: *std.Build.Dependency,
    upstream: *std.Build.Module,
) *std.Build.Module {
    const loader = "terminal/kitty/graphics_image.zig";
    const src = ghostty_dep.path("src");
    const original_path = src.path(b, loader).getPath(b);
    const original = std.Io.Dir.cwd().readFileAlloc(
        b.graph.io,
        original_path,
        b.allocator,
        .limited(4 * 1024 * 1024),
    ) catch |err| std.debug.panic("reading {s}: {}", .{ original_path, err });
    const anchor = "        // Verify our capabilities and limits allow this.\n";
    const index = std.mem.indexOf(u8, original, anchor) orelse
        @panic("graphics_image.zig: LoadingImage.init no longer checks media limits");
    const guard =
        \\        // Terax: no file system on freestanding targets (see build.zig).
        \\        if (comptime builtin.os.tag == .freestanding) return error.UnsupportedMedium;
        \\
        \\
    ;
    const patched = b.fmt("{s}{s}{s}", .{ original[0..index], guard, original[index..] });

    const tree = b.addWriteFiles();
    _ = tree.addCopyDirectory(src, "src", .{
        // Fonts are the bulk of the tree and nothing in ghostty-vt reads them.
        .exclude_extensions = &.{ loader, ".ttf", ".otf" },
    });
    _ = tree.add("src/" ++ loader, patched);

    const module = b.createModule(.{
        .root_source_file = tree.getDirectory().path(b, "src/lib_vt.zig"),
        .target = upstream.resolved_target,
        .optimize = upstream.optimize,
        .link_libc = upstream.link_libc,
        .link_libcpp = upstream.link_libcpp,
    });
    var imports = upstream.import_table.iterator();
    while (imports.next()) |entry| module.addImport(entry.key_ptr.*, entry.value_ptr.*);
    return module;
}

fn retargetMacOS27Host(b: *std.Build) void {
    const host = b.graph.host.result;
    if (host.os.tag != .macos) return;

    const version_range = host.os.version_range.semver;
    if (version_range.min.major < 27) return;

    const macos_15: std.SemanticVersion = .{
        .major = 15,
        .minor = 0,
        .patch = 0,
    };
    b.graph.host = b.resolveTargetQuery(.{
        .cpu_arch = host.cpu.arch,
        .os_tag = .macos,
        .os_version_min = .{ .semver = macos_15 },
        .os_version_max = .{ .semver = macos_15 },
        .abi = host.abi,
    });
}
