// Capacitor native printer bridge
(function() {
  window.isNativeApp = typeof Capacitor !== 'undefined' && Capacitor.isNative;

  window.nativePrint = async function(text, deviceName) {
    if (!window.isNativeApp) return false;
    try {
      const result = await Capacitor.Plugins.PrinterPlugin.print({ text: text, deviceName: deviceName || '' });
      return result.success === true;
    } catch (e) {
      console.error('Native print failed:', e);
      return false;
    }
  };
})();
