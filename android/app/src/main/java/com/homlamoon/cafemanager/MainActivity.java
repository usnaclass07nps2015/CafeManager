package com.homlamoon.cafemanager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        registerPlugin(com.homlamoon.cafemanager.plugins.PrinterPlugin.class);
    }
}
