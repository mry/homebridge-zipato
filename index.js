var zipabox = require("zipabox");
var Accessory, Service, Characteristic, platform;

'use strict';

var ZIPATO_HSLIDER = 8
var ZIPATO_SWITCH = 11
var ZIPATO_METER = 95

module.exports = function(homebridge) {
	console.log("homebridge API version: " + homebridge.version);

	// Accessory must be created from PlatformAccessory Constructor
	Accessory = homebridge.platformAccessory;

	// Service and Characteristic are from hap-nodejs
	Service = homebridge.hap.Service;
	Characteristic = homebridge.hap.Characteristic;

	homebridge.registerPlatform("homebridge-zipato", "Zipato", ZipatoPlatform, true);
}

zipabox.events.OnAfterConnect = function() {
	// This hack is needed to make sure we stay connected, as long as we talk to Zipato every X minutes we will stay logged in
	setTimeout(function() {
		zipabox.Connect(function() {
			platform.log("Connect executed successfully again");
		});
	}, 15 * 60 * 1000);
}

zipabox.events.OnAfterLoadDevice = function(device) {
	platform.log("OnAfterLoadDevice");	
	platform.log("" + device);
}

zipabox.events.OnAfterLoadDevices = function() {
	platform.log("OnAfterLoadDevices");	

	// Iterate over all Zipato devices (actually module groups)
	zipabox.ForEachDevice(function(device) {

		// log device.name
		platform.log('Device name: %s', device.name);
		platform.log('Device: %s', JSON.stringify(device, null, 4));

		// Skip all devices that is not in the configured device list
		if(platform.config["devices"] !== undefined && platform.config["devices"].indexOf(device.name) < 0) {
			platform.log('Skipping device: %s', device.name);
			return;
		}

		// Iterate overall Zipato modules within a device (module group)
		zipabox.ForEachModuleInDevice(device.name, function(uuid, module){

			platform.log('Module name: %s', module.name);
			platform.log('Module: %s', JSON.stringify(module, null, 4));

			// Skip all modules that are in the configured filter list (Relay 1, Relay 2)
			if(platform.config["filters"] !== undefined && platform.config["filters"].indexOf(module.name) >= 0) {
				platform.log('Skipping module: %s', module.name);
				return;
			}

			// Figure out the best way to have HomeKit handle this Zipato module
			if(module.attributes !== undefined && typeof module.attributes[ZIPATO_HSLIDER] !== 'undefined') {
				platform.addAccessory(Service.Lightbulb, module, uuid);
			}
			else if(device.name == "scenes" || typeof module.attributes[ZIPATO_SWITCH] !== 'undefined') {
				platform.addAccessory(Service.Switch, module, uuid);
			}
			else if(device.name == "meters" && typeof module.attributes[ZIPATO_METER] !== 'undefined') {
				if(module.attributes[ZIPATO_METER].definition.name == "TEMPERATURE") {
					platform.log('Adding TEMP: %s', module.name);
					platform.addAccessory(Service.TemperatureSensor, module, uuid);
				} else {
					platform.log('Unknown handling of TEMP: %s', module.name);
				}
			} else {
				platform.log('Unknown handling of: %s', module.name);
			}
		});
	});
}

function ZipatoPlatform(log, config, api) {
	log("ZipatoPlatform Init");
	platform = this;

	this.log = log;
	this.config = config;
	this.accessories = [];

	zipabox.username = config["username"];
	zipabox.password = config["password"];

	if(config["localip"] !== undefined) {
		log("Using local IP "+config["localip"]);
		zipabox.SetLocalIP(config["localip"]);
	}

	zipabox.showlog = false;
	zipabox.checkforupdate_auto = true;

	if (api) {
		// Save the API object as plugin needs to register new accessory via this object.
		this.api = api;

		// Listen to event "didFinishLaunching", this means homebridge already finished loading cached accessories
		// Platform Plugin should only register new accessory that doesn't exist in homebridge after this event.
		// Or start discover new accessories
		this.api.on('didFinishLaunching', function() {
			zipabox.Connect(function() {
				platform.log("OnAfterConnect");
				zipabox.LoadDevices();
			});
		});
	}
}

// Function invoked when homebridge tries to restore cached accessory
// Developer can configure accessory at here (like setup event handler)
// Update current value
ZipatoPlatform.prototype.configureAccessory = function(accessory) {
	platform.log(accessory.displayName, "Configure Accessory");

	// By default the accessory is not reachable, updated once Zipato is reachable
	accessory.reachable = false;

	accessory.on('identify', function(paired, callback) {
		platform.log(accessory.displayName, "Identify");
		callback();
	});

	// tempsensor
	if (accessory.getService(Service.TemperatureSensor)) {
		accessory.getService(Service.TemperatureSensor)
		.getCharacteristic(Characteristic.CurrentTemperature)
		.on('get', function(callback) {

			platform.log('Getting latest value for accessory %s', accessory.displayName);
			//platform.log('Accessory: %s', JSON.stringify(accessory, null, 4));

			var tjoff = zipabox.GetDeviceByUUID(accessory.UUID);
			platform.log('GetDeviceByUUID %s', JSON.stringify(tjoff.name, null, 2));
			//if(tjoff.attributes[ZIPATO_METER].value === undefined) tjoff.attributes[ZIPATO_METER].value = 0;
			//callback(null, tjoff.attributes[ZIPATO_METER].value);
			callback(null, parseFloat(tjoff.attributes[ZIPATO_METER].value));
			//callback(null, 77);

		});
	}

	// switches
	if (accessory.getService(Service.Switch)) {
		accessory.getService(Service.Switch).getCharacteristic(Characteristic.On)
			.on('set', function(value, callback) {
				if(! accessory.isScene) {
					// Simply switch the device (convert 0/1 to false/true)
					zipabox.SetDeviceValue(accessory.UUID, ZIPATO_SWITCH, !!value,
							function(msg) {
								callback();
							},
							function(err) {
								callback(err);
							});
				} else {
					// Only run a scene when it is turned on
					if (!value) {
						callback();
						return;
					}

					// Run the actual scene
					zipabox.RunUnLoadedScene(accessory.UUID,
							function(msg) {
								callback();

								// Automatically turn back off after half a second
								setTimeout(function() {
									accessory.getService(Service.Switch).setCharacteristic(Characteristic.On, 0);
								}, 500);
							},
							function(err) {
								callback(err);
							});
				}
			});
	}

	// lights
	if (accessory.getService(Service.Lightbulb)) {
		accessory.getService(Service.Lightbulb)
			.getCharacteristic(Characteristic.On)
			.on('set', function(value, callback) {
				// In case we are switching on but the brightness is zero we go all in
				if(value && !accessory.brightness) accessory.brightness = 100;

				// Use the brightness to switch between states
				zipabox.SetDeviceValue(accessory.UUID, ZIPATO_HSLIDER, value?accessory.brightness:0,
						function(msg) {
							callback();
						},
						function(err) {
							callback(err);
						});
			});
		accessory.getService(Service.Lightbulb)
			.getCharacteristic(Characteristic.Brightness)
			.on('set', function(value, callback) {
				zipabox.SetDeviceValue(accessory.UUID, ZIPATO_HSLIDER, value,
						function(msg) {
							accessory.brightness = value;
							callback();
						},
						function(err) {
							callback(err);
						});
			})
			.on('get', function(callback) {
				if(accessory.brightness === undefined) accessory.brightness = 0;
				callback(accessory.brightness);
			});
	}

	this.accessories.push(accessory);
}

ZipatoPlatform.prototype.updateAccessory = function(accessory, module) {
	// Used to detect if this is a scene
	accessory.isScene = (module.uri_run !== undefined);

	// Consider the accessory reachable since Zipato still has it
	accessory.updateReachability(true);
}

ZipatoPlatform.prototype.addAccessory = function(service, module, uuid) {
	// Prevent adding the same accessory twice
	for(var i in this.accessories) if(this.accessories[i].UUID == uuid) {
		this.updateAccessory(this.accessories[i], module);
		return;
	}

	// Apply replace configuration onto module name
	var name = module.name;
	if(this.config["replace"] !== undefined) {
		for(var key in this.config["replace"]) {
			platform.log(key);
			platform.log(name);
			name = name.replace(key, this.config["replace"][key]);
			platform.log(name);
		}
	}

	var newAccessory = new Accessory(name, uuid);

	// Setup the initial service that we want to use for this accessory
	newAccessory.addService(service, name);

	// Configure the accessory (this sets up all the relevant callbacks
	this.configureAccessory(newAccessory);

	// A new accessory is created by Zipato so always reachable
	this.updateAccessory(newAccessory, module);

	this.api.registerPlatformAccessories("homebridge-zipato", "Zipato", [newAccessory]);
}

