import { describe, expect, test } from 'bun:test';
import { causeKind, causeLabel, knownCauses } from './causes';

describe('causeLabel', () => {
	test('named weapons, tools, buildables and vehicles', () => {
		expect(causeLabel('Id.Item.AK74M')).toBe('AK-74M');
		expect(causeLabel('Id.Item.WEPN_029')).toBe('Galil');
		expect(causeLabel('Id.Item.M4')).toBe('M4');
		expect(causeLabel('Id.Item.M67Grenade')).toBe('M67 frag grenade');
		expect(causeLabel('Id.Item.Crowbar')).toBe('Halligan bar');
		expect(causeLabel('ID.Item.BuildTool.Hammer.Large')).toBe('Large hammer');
		expect(causeLabel('Id.Buildable.TallHBlock')).toBe('Tall H-block');
		expect(causeLabel('Vehicle.Variant.Air.Rotary.Littlebird.Default')).toBe('MH-6');
		expect(causeLabel('Vehicle.Variant.Land.Tracked.SpawnVehicle.Lonestar')).toBe('M113 APC');
		expect(causeLabel('Vehicle.Variant.Stationary.Phalanx')).toBe('Vanguard CIWS');
		expect(causeLabel('Id.Vehicle.WeaponExtension.WHL_02.SUV.RingTurret')).toBe('Kodiak M249');
		expect(causeLabel('Id.Vehicle.WeaponExtension.ROT_02.30mmCannon')).toBe(
			'Havoc 2A42 autocannon'
		);
	});

	test("a named tag in the game's other casing keeps its name", () => {
		expect(causeLabel('ID.Item.M67Grenade')).toBe('M67 frag grenade');
		expect(causeLabel('Id.Item.BuildTool.Hammer.Small')).toBe('Small hammer');
		expect(causeLabel('ID.Item.Fists')).toBe('Fists');
		expect(causeLabel('ID.Vehicle.WeaponExtension.STN_01.MistralAA')).toBe('Talon 9K-SAM');
	});

	test('unnamed tags read from their segments', () => {
		expect(causeLabel('Id.Item.Mosin')).toBe('Mosin');
		expect(causeLabel('Id.Item.WEPN_035')).toBe('WEPN 035');
		expect(causeLabel('Id.Item.SMG_03')).toBe('SMG 03');
		expect(causeLabel('Vehicle.Variant.Land.Wheeled.Ural.Default')).toBe('Ural');
		expect(causeLabel('Vehicle.Variant.Land.Wheeled.Ural.Transport')).toBe('Ural (transport)');
		expect(causeLabel('Vehicle.Variant.Air.Rotary.ROT_05.Default')).toBe('ROT 05');
		expect(causeLabel('Id.Vehicle.WeaponExtension.STN_09.Turret')).toBe('STN 09 Turret');
		expect(causeLabel('Id.Buildable.Gate')).toBe('Gate');
		expect(causeLabel('Id.Vehicle.WeaponExtension.WHL_09.RingTurret')).toBe('WHL 09 Ring turret');
	});

	test('the named causes as filter choices, alphabetical by label', () => {
		const list = knownCauses();
		expect(list.find((c) => c.cause === 'Id.Item.WEPN_029')?.label).toBe('Galil');
		expect(list.map((c) => c.label)).toEqual(
			[...list.map((c) => c.label)].sort((a, b) => a.localeCompare(b))
		);
	});

	test('nothing for no cause', () => {
		expect(causeLabel(null)).toBe('');
		expect(causeLabel('')).toBe('');
	});
});

describe('causeKind', () => {
	test('by prefix', () => {
		expect(causeKind('Id.Item.AK74M')).toBe('weapon');
		expect(causeKind('ID.Item.BuildTool.Hammer.Large')).toBe('weapon');
		expect(causeKind('Id.Vehicle.WeaponExtension.STN_03.MainBarrel')).toBe('vehicle weapon');
		expect(causeKind('Vehicle.Variant.Air.Rotary.Littlebird.Default')).toBe('vehicle');
		expect(causeKind('Id.Buildable.Gate')).toBe('buildable');
		expect(causeKind(null)).toBe('none');
	});
});
