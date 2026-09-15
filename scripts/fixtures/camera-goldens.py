#!/usr/bin/env python3
"""Golden generator for the camera-compiler port (task ving89w).

Runs the UPSTREAM bruxosdovfx v19.1 compiler over canonical trajectories and
emits the fixture consumed by scripts/test-camera.cjs. The upstream package
imports cleanly without ComfyUI (its only ComfyUI import is lazy and never
reached here).

Regeneration procedure (documented so the fixture is reproducible, never
regenerated from the TS side — the whole point is independence):

    git clone https://github.com/NyckM/3d-Camera-control-H3-Minimax /tmp/h3cam-src
    mkdir -p /tmp/h3cam-golden/h3cam && cp /tmp/h3cam-src/*.py /tmp/h3cam-golden/h3cam/
    H3CAM_SRC=/tmp/h3cam-golden python3 scripts/fixtures/camera-goldens.py \
        scripts/fixtures/camera-goldens.json

Upstream pin this fixture was generated from:
    repo   https://github.com/NyckM/3d-Camera-control-H3-Minimax
    commit 846880de859959e801b2c506dc424bd5c8b5c6c4 (2026-09-13, README v19.1)
    license Apache-2.0
"""
import contextlib
import datetime
import io
import json
import math
import os
import sys

SRC = os.environ.get('H3CAM_SRC', '/tmp/h3cam-golden')
sys.path.insert(0, SRC)
with contextlib.redirect_stdout(io.StringIO()):  # swallow print_banner
    import h3cam.motion as motion
    import h3cam.camera as base
    import h3cam.diagnostics as diagnostics

SRC_REPO = 'https://github.com/NyckM/3d-Camera-control-H3-Minimax'
SRC_COMMIT = '846880de859959e801b2c506dc424bd5c8b5c6c4'


class FakeImage:
    """ComfyUI IMAGE stand-in: only .shape and batch slicing are read.

    Batch-axis slicing returns a FakeImage whose leading dimension is the
    sliced length, so `frames[:aligned].shape[0]` reports the TRUNCATED count
    exactly like a real tensor (a naive return-self stub would hide the 17k+5
    truncation from the recorded info banner)."""

    def __init__(self, shape):
        self.shape = list(shape)

    def __getitem__(self, key):
        count = self.shape[0]
        rest = list(self.shape[1:])
        if isinstance(key, slice):
            start, stop, step = key.indices(count)
            assert step == 1, key
            return FakeImage([max(0, stop - start)] + rest)
        if isinstance(key, list):
            return FakeImage([len(key)] + rest)
        return self


class _Dummy:
    pass


# Canonical trajectories: the clone's examples/direita_90, esquerda_90 and
# video_00063_original verbatim, plus port-specific shapes (loop closure,
# near-miss loop, reversal+hold, push-in, left-handed full circle).
EXAMPLES = {
    'direita_90': [
        dict(time=0, azimuth=0, elevation=0, distance=1),
        dict(time=1, azimuth=90, elevation=0, distance=1),
    ],
    'esquerda_90': [
        dict(time=0, azimuth=0, elevation=0, distance=1),
        dict(time=1, azimuth=-90, elevation=0, distance=1),
    ],
    'video_00063': [
        dict(time=0, azimuth=0, elevation=0, distance=1),
        dict(time=0.5, azimuth=38, elevation=10, distance=1),
        dict(time=1, azimuth=90, elevation=0, distance=0.8),
    ],
    'loop_circle': [
        dict(time=0, azimuth=0, elevation=0, distance=1),
        dict(time=0.5, azimuth=180, elevation=8, distance=1.2),
        dict(time=1, azimuth=360, elevation=0, distance=1),
    ],
    'loop_355': [
        dict(time=0, azimuth=0, elevation=0, distance=1),
        dict(time=0.5, azimuth=178, elevation=5, distance=1.1),
        dict(time=1, azimuth=355, elevation=0, distance=1),
    ],
    'reversal_hold': [
        dict(time=0, azimuth=0, elevation=0, distance=1),
        dict(time=0.15, azimuth=0, elevation=0, distance=1),
        dict(time=0.5, azimuth=40, elevation=6, distance=1),
        dict(time=0.75, azimuth=40, elevation=6, distance=1),
        dict(time=1, azimuth=-30, elevation=0, distance=0.9),
    ],
    'push_in': [
        dict(time=0, azimuth=0, elevation=0, distance=1),
        dict(time=1, azimuth=0, elevation=12, distance=0.45),
    ],
    'loop_circle_left': [
        dict(time=0, azimuth=0, elevation=0, distance=1),
        dict(time=0.5, azimuth=-180, elevation=8, distance=1.2),
        dict(time=1, azimuth=-360, elevation=0, distance=1),
    ],
}


def path_json(name):
    return json.dumps(EXAMPLES[name])


def _jsonable_input(args):
    out = {}
    for key, value in args.items():
        if isinstance(value, FakeImage):
            out[key] = {'shape': list(value.shape)}
        else:
            out[key] = value
    return out


def run_compile(case_id, **kw):
    args = dict(
        raw=path_json(kw.pop('path')), profile='124 frames (~5.17s)',
        interpolation='smooth', instruction='', framing=None, minimax_format=None,
        reference_image=None, elevation_range=None, orbit_direction=None,
        subject_box=None, runtime_task=None, prompt_detail=None, allow_closure=True)
    args.update(kw)
    result = base.compile_camera(**args)
    return dict(
        id=case_id, driver='compile', input=_jsonable_input(args),
        outputs=dict(
            compiled_prompt=result[0], options=result[1],
            options_json=json.dumps(result[1], ensure_ascii=False, indent=2),
            storyboard_json=result[2],
            info=result[3], minimax_prompt=result[4], frames=result[5], fps=result[6]),
    )


def run_motion(case_id, **kw):
    args = dict(
        camera_trajectory=path_json(kw.pop('path')), profile='124 frames (~5.17s)',
        interpolation='smooth', instruction='', subject_framing=None,
        minimax_format=None, reference_image=None, elevation_range=None,
        orbit_direction=None, subject_box=None, runtime_task=None, prompt_detail=None,
        frame_mode='Freeze Frame', source_fps=24., freeze_index=0,
        ui_language='Português', loop_closure='auto')
    args.update(kw)
    result = motion.H3CameraEditor.run(_Dummy(), **args)
    return dict(
        id=case_id, driver='motion', input=_jsonable_input(args),
        outputs=dict(
            compiled_prompt=result[0], options=result[1],
            options_json=json.dumps(result[1], ensure_ascii=False, indent=2),
            storyboard_json=result[2],
            info=result[3], minimax_prompt=result[4], frames=result[5], fps=result[6]),
    )


def main():
    img169 = FakeImage([1, 1080, 1920, 3])
    img916 = FakeImage([1, 2160, 1080, 3])
    seq61 = FakeImage([61, 1080, 1920, 3])
    seq97 = FakeImage([97, 1350, 1080, 3])

    cases = [
        run_compile('freeze_orbit90_v15', path='direita_90'),
        run_compile('freeze_left90_lin_ext_sections', path='esquerda_90',
                    profile='362 frames (~15.08s)', interpolation='linear',
                    instruction='Keep the mood.', framing='close-up',
                    minimax_format='coordinate + H3 sections',
                    reference_image=img916, elevation_range='+/-15',
                    subject_box='[L=0.516, T=0.148, W=0.071, H=0.249]',
                    prompt_detail='extended contracts'),
        run_compile('freeze_multikey_json', path='video_00063',
                    profile='243 frames (~10.13s)', minimax_format='compact JSON',
                    reference_image=img169),
        run_compile('freeze_loop360', path='loop_circle',
                    reference_image=img169),
        run_compile('freeze_reversal_hold_ext', path='reversal_hold',
                    profile='243 frames (~10.13s)',
                    prompt_detail='extended contracts'),
        run_compile('freeze_directed39', path='direita_90',
                    profile='243 frames (~10.13s)',
                    runtime_task='directed | new camera angle'),
        run_motion('node_freeze_samehud_en', path='direita_90',
                   orbit_direction='same as HUD', ui_language='English',
                   reference_image=img169),
        run_motion('node_freeze_multikey_pt_off', path='video_00063',
                   profile='243 frames (~10.13s)',
                   instruction='Coastal ruins at dusk.',
                   prompt_detail='extended contracts', loop_closure='off',
                   reference_image=img169),
        run_motion('node_freeze_loop355', path='loop_355',
                   reference_image=img169),
        run_motion('node_freeze_reversal_lin', path='reversal_hold',
                   interpolation='linear', minimax_format='coordinate + H3 sections',
                   ui_language='English', reference_image=img169),
        run_motion('node_freeze_push_in', path='push_in',
                   prompt_detail='extended contracts', ui_language='English',
                   reference_image=img169),
        run_motion('node_motion_multikey', path='video_00063',
                   frame_mode='Motion Frame', source_fps=12.,
                   minimax_format='coordinate + H3 sections',
                   subject_box='[L=0.4, T=0.1, W=0.25, H=0.6]',
                   reference_image=seq61),
        run_motion('node_motion_portrait', path='direita_90',
                   frame_mode='Motion Frame', profile='243 frames (~10.13s)',
                   interpolation='linear', prompt_detail='extended contracts',
                   minimax_format='compact JSON', source_fps=30.,
                   ui_language='English', reference_image=seq97),
        run_motion('node_motion_loop360', path='loop_circle',
                   frame_mode='Motion Frame', source_fps=12.,
                   reference_image=seq61),
        run_motion('node_motion_left360_json', path='loop_circle_left',
                   frame_mode='Motion Frame', source_fps=24.,
                   minimax_format='compact JSON', reference_image=seq61,
                   ui_language='English'),
    ]

    # -- validation taxonomy --------------------------------------------------
    many = [dict(time=i / 24.0, azimuth=i * 5, elevation=0, distance=1)
            for i in range(25)]
    spin = [dict(time=0, azimuth=0, elevation=0, distance=1),
            dict(time=1, azimuth=11700, elevation=0, distance=1)]
    valid_two = '[{"time": 0, "azimuth": 0, "elevation": 0, "distance": 1}, {"time": 1, "azimuth": 90, "elevation": -12.5, "distance": 2}]'
    raws = [
        ('not_json', 'nope'),
        ('scalar', '5'),
        ('string', '"abc"'),
        ('empty_array', '[]'),
        ('one_keyframe', '[{"time":0,"azimuth":0,"elevation":0,"distance":1}]'),
        ('twenty_five', json.dumps(many)),
        ('item_not_object', '[1, 2]'),
        ('item_null', '[null, {"time":1,"azimuth":0,"elevation":0,"distance":1}]'),
        ('missing_distance', '[{"time":0,"azimuth":0,"elevation":0},{"time":1,"azimuth":90,"elevation":0,"distance":1}]'),
        ('string_value', '[{"time":0,"azimuth":"90","elevation":0,"distance":1},{"time":1,"azimuth":90,"elevation":0,"distance":1}]'),
        ('bool_value', '[{"time":0,"azimuth":true,"elevation":0,"distance":1},{"time":1,"azimuth":90,"elevation":0,"distance":1}]'),
        ('nan_value', '[{"time":0,"azimuth":NaN,"elevation":0,"distance":1},{"time":1,"azimuth":90,"elevation":0,"distance":1}]'),
        ('infinity_value', '[{"time":0,"azimuth":0,"elevation":0,"distance":Infinity},{"time":1,"azimuth":90,"elevation":0,"distance":1}]'),
        ('overflow_exponent', '[{"time":0,"azimuth":1e999,"elevation":0,"distance":1},{"time":1,"azimuth":90,"elevation":0,"distance":1}]'),
        ('time_above_one', '[{"time":0,"azimuth":0,"elevation":0,"distance":1},{"time":1.5,"azimuth":90,"elevation":0,"distance":1}]'),
        ('time_negative', '[{"time":-0.1,"azimuth":0,"elevation":0,"distance":1},{"time":1,"azimuth":90,"elevation":0,"distance":1}]'),
        ('elevation_out', '[{"time":0,"azimuth":0,"elevation":-90,"distance":1},{"time":1,"azimuth":90,"elevation":0,"distance":1}]'),
        ('distance_low', '[{"time":0,"azimuth":0,"elevation":0,"distance":0.05},{"time":1,"azimuth":90,"elevation":0,"distance":1}]'),
        ('distance_high', '[{"time":0,"azimuth":0,"elevation":0,"distance":1},{"time":1,"azimuth":90,"elevation":0,"distance":5}]'),
        ('times_equal', '[{"time":0,"azimuth":0,"elevation":0,"distance":1},{"time":0.5,"azimuth":45,"elevation":0,"distance":1},{"time":0.5,"azimuth":90,"elevation":0,"distance":1}]'),
        ('times_decreasing', '[{"time":0,"azimuth":0,"elevation":0,"distance":1},{"time":0.8,"azimuth":45,"elevation":0,"distance":1},{"time":0.5,"azimuth":90,"elevation":0,"distance":1}]'),
        ('anchor_azimuth', '[{"time":0,"azimuth":5,"elevation":0,"distance":1},{"time":1,"azimuth":90,"elevation":0,"distance":1}]'),
        ('anchor_distance', '[{"time":0,"azimuth":0,"elevation":0,"distance":1.1},{"time":1,"azimuth":90,"elevation":0,"distance":1}]'),
        ('turn_cap', json.dumps(spin)),
        ('valid_two', valid_two),
        ('valid_loose_numbers', '[{"time":0,"azimuth":0.0,"elevation":0,"distance":1.0},{"time":1,"azimuth":90.0,"elevation":0.0,"distance":1.0}]'),
        ('valid_extra_keys', '[{"time":0,"azimuth":0,"elevation":0,"distance":1,"note":"x"},{"time":1,"azimuth":90,"elevation":0,"distance":1}]'),
    ]
    validation = []
    for label, raw in raws:
        try:
            validation.append(dict(label=label, raw=raw, error=None,
                                   path=base.validate_path(raw)))
        except ValueError as exc:
            validation.append(dict(label=label, raw=raw, error=str(exc), path=None))

    option_errors = []
    for label, kwargs in [
        ('unknown_profile', dict(profile='99 frames')),
        ('unknown_interpolation', dict(interpolation='cubic')),
        ('unknown_orbit', dict(orbit_direction='sideways')),
        ('unknown_format', dict(minimax_format='yaml')),
        ('empty_orbit_falls_back', dict(orbit_direction='')),
        ('none_format_falls_back', dict(minimax_format=None)),
    ]:
        try:
            base.compile_camera(path_json('direita_90'), kwargs.pop('profile', '124 frames (~5.17s)'),
                                kwargs.pop('interpolation', 'smooth'), '', **kwargs)
            option_errors.append(dict(label=label, error=None))
        except ValueError as exc:
            option_errors.append(dict(label=label, error=str(exc)))

    # -- interpolation reference table ----------------------------------------
    table = []
    for name in ('video_00063', 'reversal_hold', 'loop_circle'):
        path = EXAMPLES[name]
        for interp, detail in (('smooth', 'extended contracts'),
                               ('smooth', 'v15 baseline'), ('linear', 'v15 baseline')):
            samples = []
            for i in range(21):
                t = i / 20.0
                samples.append(dict(time=t, **base.interpolate_pose(path, t, interp, detail)))
            samples.append(dict(time=-0.25, **base.interpolate_pose(path, -0.25, interp, detail)))
            samples.append(dict(time=1.25, **base.interpolate_pose(path, 1.25, interp, detail)))
            table.append(dict(path=name, interpolation=interp, detail=detail, samples=samples))
    slope_path = [dict(time=0, azimuth=0, elevation=0, distance=1),
                  dict(time=0.3, azimuth=100, elevation=10, distance=1.5),
                  dict(time=0.7, azimuth=-40, elevation=-10, distance=0.8),
                  dict(time=1, azimuth=20, elevation=4, distance=1)]
    slope_samples = [dict(time=i / 40.0,
                          **base.interpolate_pose(slope_path, i / 40.0, 'smooth', 'extended contracts'))
                     for i in range(41)]
    interp_errors = []
    for interp, detail in (('smooth', 'extended contracts'), ('smooth', 'v15 baseline')):
        try:
            base.interpolate_pose(slope_path, math.nan, interp, detail)
            interp_errors.append(dict(label='nan_time', error=None))
        except ValueError as exc:
            interp_errors.append(dict(label='nan_time', error=str(exc)))
    try:
        base.interpolate_pose([], 0.5)
        interp_errors.append(dict(label='empty_path', error=None))
    except ValueError as exc:
        interp_errors.append(dict(label='empty_path', error=str(exc)))

    # -- helper vocabulary ------------------------------------------------------
    helpers = dict(
        end_view=[dict(net=net, text=base.end_view(net))
                  for net in (0, 1, 90, 180, 359, 360, 361, 725.5, -90, -360, 1080)],
        parallax=[dict(daz=a, de=e, aspect=sp, text=base.parallax_travel(a, e, sp))
                  for a, e, sp in ((132, 0, None), (360, 0, None), (-90, 0, None),
                                   (8, 0, None), (3, 6, None), (40, -12, None),
                                   (90, 0, 9 / 16), (0, 10, None), (2, 2, None),
                                   (700, 30, None))],
        aspect_label=[dict(aspect=a, label=base.aspect_label(a))
                      for a in (None, 16 / 9, 9 / 16, 1.0, 0.8, 0.5625, 21 / 9,
                                2.39, 0.751, 3 / 4)],
        horizontal_fov=[dict(aspect=a, fov=base.horizontal_fov(a))
                        for a in (None, 9 / 16, 2.39)],
        direction_contract=[
            dict(path=name, text=base._direction_contract(EXAMPLES[name]))
            for name in ('direita_90', 'esquerda_90', 'video_00063',
                         'reversal_hold', 'push_in')],
        float_repr=[dict(value=repr(v), label=repr(v))
                    for v in (0.0, 24.0, 90.0, 5.125, 7.520833333333333,
                              1e-06, 1.5e-07, 0.0001, 2e-05, -0.5, 132.5,
                              1e21, 360.0, 0.1, 107.98387096774194, -0.0)],
        format_g=[dict(value=f'{v:g}', label=repr(v))
                  for v in (0, 24.0, 90.0, 132.5, 360.0, 1.0, 2.0, 0.5,
                            72.48387096774194, 15.041666666666666, 11520.0,
                            0.0001, 0.00001, 1234567.0, 30.0, 0.25, 355.0,
                            8.0, 1.2, 0.45, -30.0, 12.0, 6.0, 11700.0)],
        round6=[dict(value=repr(round(v, 6)), label=repr(v))
                for v in (0.0, 61.0 / 24, 0.5 * 243 / 24, 0.1234565,
                          2.5000005, 1.0000005, 0.1 + 0.2)],
        round3=[dict(value=repr(round(v, 3)), label=repr(v))
                for v in (90.0 / (0.5 * 243 / 24), 90.0 / (1.0 * 124 / 24),
                          0.0005, 1.0005, 2.675, 8.335)],
        image_aspect=[dict(shape=list(s), aspect=base.image_aspect(FakeImage(list(s))))
                      for s in ([1, 1080, 1920, 3], [7, 2160, 1080, 3],
                                [2, 1000, 1000, 3], [3], [1080, 1920])],
    )
    try:
        helpers['image_aspect'].append(dict(shape='no_shape', aspect=base.image_aspect(object())))
    except Exception as exc:  # noqa: BLE001
        helpers['image_aspect'].append(dict(shape='no_shape', aspect=f'ERR {exc}'))

    # -- diagnostics ------------------------------------------------------------
    diag = []
    for name, duration, limit in (('reversal_hold', 10.125, 30),
                                  ('loop_circle', 5.125, 15),
                                  ('push_in', 5.125, 30),
                                  ('video_00063', 5.125, 30)):
        items = diagnostics.review_path(EXAMPLES[name], duration, limit)
        diag.append(dict(path=name, duration=duration, elevation_limit=limit,
                         items=items,
                         en_text=diagnostics.diagnostic_text(items, True),
                         pt_text=diagnostics.diagnostic_text(items, False)))
    static_path = [dict(time=0, azimuth=0, elevation=0, distance=1),
                   dict(time=0.4, azimuth=0, elevation=0, distance=1),
                   dict(time=1, azimuth=0, elevation=0, distance=1)]
    items = diagnostics.review_path(static_path, 5.125, 30)
    diag.append(dict(path='static', duration=5.125, elevation_limit=30, items=items,
                     en_text=diagnostics.diagnostic_text(items, True),
                     pt_text=diagnostics.diagnostic_text(items, False)))

    # -- motion resampling math ---------------------------------------------------
    resample = []
    for count, fps in ((61, 12.0), (97, 30.0), (240, 24.0), (2, 24.0), (2, 48.0),
                       (721, 24.0), (480, 48.0), (100, 240.0)):
        try:
            _, frames, n = motion.prepare_frames(FakeImage([count, 1080, 1920, 3]),
                                                 'Motion Frame', fps, 0)
            resample.append(dict(count=count, source_fps=fps, error=None,
                                 target_count=int(frames.shape[0]) if frames is not None else None,
                                 input_count=n, indices=None))
        except ValueError as exc:
            resample.append(dict(count=count, source_fps=fps, error=str(exc),
                                 target_count=None, input_count=None, indices=None))
    for count, fps in ((61, 12.0), (97, 30.0)):
        target = int(round(count * 24 / fps))
        aligned = 5 + 17 * ((target - 5) // 17)
        indices = [min(count - 1, int(i * fps / 24)) for i in range(target)][:aligned]
        resample.append(dict(count=count, source_fps=fps, error=None,
                             target_count=aligned, input_count=count,
                             indices=indices, target_unaligned=target))
    for count, fps in ((5, 24.0),):
        try:
            _, frames, n = motion.prepare_frames(FakeImage([count, 1080, 1920, 3]),
                                                 'Freeze Frame', fps, 4)
            resample.append(dict(count=count, source_fps=fps, mode='freeze',
                                 error=None, target_count=int(frames.shape[0]),
                                 input_count=n, indices=None))
        except ValueError as exc:
            resample.append(dict(count=count, source_fps=fps, mode='freeze',
                                 error=str(exc), target_count=None,
                                 input_count=None, indices=None))
        try:
            motion.prepare_frames(FakeImage([count, 1080, 1920, 3]),
                                  'Freeze Frame', fps, 9)
            resample.append(dict(count=count, source_fps=fps, mode='freeze_oob', error=None))
        except ValueError as exc:
            resample.append(dict(count=count, source_fps=fps, mode='freeze_oob', error=str(exc)))
    try:
        motion.prepare_frames(None, 'Motion Frame', 24.0, 0)
        resample.append(dict(count=None, source_fps=24.0, mode='missing_seq', error=None))
    except ValueError as exc:
        resample.append(dict(count=None, source_fps=24.0, mode='missing_seq', error=str(exc)))
    try:
        motion.prepare_frames(FakeImage([2, 4, 5, 3]), 'Motion Frame', 0.0, 0)
        resample.append(dict(count=2, source_fps=0.0, mode='bad_fps', error=None))
    except ValueError as exc:
        resample.append(dict(count=2, source_fps=0.0, mode='bad_fps', error=str(exc)))
    try:
        motion.prepare_frames(FakeImage([2, 4, 5]), 'Motion Frame', 24.0, 0)
        resample.append(dict(count=2, source_fps=24.0, mode='bad_shape', error=None))
    except ValueError as exc:
        resample.append(dict(count=2, source_fps=24.0, mode='bad_shape', error=str(exc)))
    try:
        motion.H3CameraEditor.run(_Dummy(), path_json('direita_90'),
                                  '124 frames (~5.17s)', 'smooth', '',
                                  runtime_task='directed | new camera angle',
                                  frame_mode='Motion Frame')
        resample.append(dict(mode='motion_vs_task', error=None))
    except ValueError as exc:
        resample.append(dict(mode='motion_vs_task', error=str(exc)))

    fixture = dict(
        _provenance=dict(
            source_repo=SRC_REPO, source_commit=SRC_COMMIT,
            source_version='v19.1 (README/banner); pyproject 20.0.0',
            source_license='Apache-2.0',
            generated=datetime.datetime.now().isoformat(),
            generator='camera-goldens.py (task ving89w) — runs the upstream '
                      'compiler directly; never regenerate from the TS port',
            python_version=sys.version.split()[0],
        ),
        cases=cases,
        validation=validation,
        option_errors=option_errors,
        interpolation=table,
        interp_errors=interp_errors,
        slope_samples=dict(path='slope', samples=slope_samples),
        helpers=helpers,
        diagnostics=diag,
        resample=resample,
    )
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), 'camera-goldens.json')
    with open(out, 'w', encoding='utf-8') as fh:
        json.dump(fixture, fh, ensure_ascii=False, indent=2, sort_keys=False)
        fh.write('\n')
    print(f'wrote {out}: {len(cases)} cases, {len(validation)} validation rows, '
          f'{len(table)} interpolation series')


if __name__ == '__main__':
    main()
