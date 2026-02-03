console.log("Service Worker Loaded");

chrome.runtime.onInstalled.addListener(() => {
  console.log("Extension Installed");
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log("Message received:", request);

  if (request.action === "GET_USER_ID") {
    chrome.scripting
      .executeScript({
        target: { tabId: sender.tab.id },
        world: "MAIN",
        func: () => {
          return (
            window.App?.context?.dispatcher?.stores?.ApplicationStore?.userData
              ?.id || null
          );
        },
      })
      .then((results) => {
        sendResponse({
          success: true,
          userId: results?.[0]?.result || null,
        });
      })
      .catch((err) => {
        sendResponse({
          success: false,
          error: err.message,
        });
      });

    return true;
  }
});
