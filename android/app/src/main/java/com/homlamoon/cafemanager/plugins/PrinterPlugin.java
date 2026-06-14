package com.homlamoon.cafemanager.plugins;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothSocket;
import android.Manifest;
import android.content.pm.PackageManager;
import android.util.Log;

import androidx.core.app.ActivityCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.UUID;

@CapacitorPlugin(name = "PrinterPlugin")
public class PrinterPlugin extends Plugin {

    private static final String TAG = "PrinterPlugin";
    private static final UUID SPP_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");

    @PluginMethod
    public void echo(PluginCall call) {
        String value = call.getString("value");
        JSObject ret = new JSObject();
        ret.put("value", value);
        call.resolve(ret);
    }

    @PluginMethod
    public void print(PluginCall call) {
        String text = call.getString("text", "");
        String deviceName = call.getString("deviceName", "");

        if (text.isEmpty()) {
            call.reject("Text is empty");
            return;
        }

        BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
        if (adapter == null) {
            call.reject("Bluetooth not supported on this device");
            return;
        }

        if (!adapter.isEnabled()) {
            call.reject("Bluetooth is not enabled");
            return;
        }

        BluetoothDevice target = null;
        Set<BluetoothDevice> pairedDevices = adapter.getBondedDevices();
        if (pairedDevices != null) {
            for (BluetoothDevice device : pairedDevices) {
                if (deviceName.isEmpty() || device.getName() != null && device.getName().contains(deviceName)) {
                    target = device;
                    break;
                }
            }
        }

        if (target == null) {
            call.reject("No paired Bluetooth printer found. Please pair your printer in Android Settings first.");
            return;
        }

        try {
            // Check permission for Android 12+
            if (ActivityCompat.checkSelfPermission(getContext(), Manifest.permission.BLUETOOTH_CONNECT)
                    != PackageManager.PERMISSION_GRANTED) {
                call.reject("BLUETOOTH_CONNECT permission not granted");
                return;
            }

            BluetoothSocket socket = target.createRfcommSocketToServiceRecord(SPP_UUID);
            adapter.cancelDiscovery();
            socket.connect();

            OutputStream outputStream = socket.getOutputStream();

            // ESC/POS commands
            byte[] init = new byte[]{0x1B, 0x40};                                   // ESC @ - Initialize printer
            byte[] boldOn = new byte[]{0x1B, 0x45, 0x01};                           // ESC E 1 - Bold on
            byte[] boldOff = new byte[]{0x1B, 0x45, 0x00};                          // ESC E 0 - Bold off
            byte[] alignCenter = new byte[]{0x1B, 0x61, 0x01};                      // ESC a 1 - Center align
            byte[] alignLeft = new byte[]{0x1B, 0x61, 0x00};                        // ESC a 0 - Left align
            byte[] cutPaper = new byte[]{0x1D, 0x56, 0x00};                         // GS V 0 - Cut paper
            byte[] lineFeed = new byte[]{0x0A};                                     // LF
            byte[] feedLines = new byte[]{0x1B, 0x64, 0x03};                        // ESC d 3 - Feed 3 lines

            outputStream.write(init);
            outputStream.write(alignCenter);
            outputStream.write(boldOn);

            // Send text line by line
            String[] lines = text.split("\n");
            for (String line : lines) {
                String trimmed = line.trim();
                if (trimmed.startsWith("---") || trimmed.startsWith("Homlamoon") || trimmed.startsWith("Thank")) {
                    outputStream.write(boldOn);
                } else {
                    outputStream.write(boldOff);
                }
                byte[] lineBytes = (line + "\n").getBytes(StandardCharsets.UTF_8);
                outputStream.write(lineBytes);
            }

            outputStream.write(boldOff);
            outputStream.write(feedLines);
            outputStream.write(cutPaper);
            outputStream.flush();
            outputStream.close();
            socket.close();

            JSObject ret = new JSObject();
            ret.put("success", true);
            ret.put("device", target.getName());
            call.resolve(ret);
        } catch (IOException e) {
            Log.e(TAG, "Print error", e);
            call.reject("Print failed: " + e.getMessage());
        }
    }
}
