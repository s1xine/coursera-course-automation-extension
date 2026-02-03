document.addEventListener("DOMContentLoaded", loadDynamicCounts);

async function loadDynamicCounts() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (!tab?.id) return;

    chrome.tabs.sendMessage(
      tab.id,
      { action: "FETCH_DYNAMIC_DATA" },
      (response) => {
        if (chrome.runtime.lastError) {
          console.error(
            "Popup connection error:",
            chrome.runtime.lastError.message,
          );
          return;
        }

        if (!response || !response.success) {
          console.error("Material fetch failed");
          return;
        }

        const data = response.data;

        console.log("Popup material data:", data);

        updateCheckboxLabel("lecture", "Videos", data.lecture?.length || 0);
        updateCheckboxLabel(
          "supplement",
          "Readings",
          data.supplement?.length || 0,
        );
        updateCheckboxLabel(
          "gradedProgramming",
          "Programming",
          data.gradedProgramming?.length || 0,
        );
        updateCheckboxLabel(
          "staffGraded",
          "Assignments",
          data.staffGraded?.length || 0,
        );
        updateCheckboxLabel("quiz", "Quizzes", data.quiz?.length || 0);
        updateCheckboxLabel("exam", "Exams", data.exam?.length || 0);
      },
    );
  } catch (err) {
    console.error("Popup error:", err);
  }
}

function updateCheckboxLabel(id, label, count) {
  const checkbox = document.getElementById(id);
  if (!checkbox) return;

  const labelElement = checkbox.closest("label");
  if (!labelElement) return;

  const textSpan = labelElement.querySelector(".label-text");
  if (!textSpan) return;

  textSpan.textContent = `${label} (${count})`;

  // Disable if empty
  checkbox.disabled = count === 0;
}

document.getElementById("runBtn").addEventListener("click", async () => {
  const options = {
    lecture: document.getElementById("lecture").checked,
    supplement: document.getElementById("supplement").checked,
    gradedProgramming: document.getElementById("gradedProgramming").checked,
    staffGraded: document.getElementById("staffGraded").checked,
    quiz: document.getElementById("quiz").checked,
    exam: document.getElementById("exam").checked,
  };

  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  chrome.tabs.sendMessage(tab.id, {
    action: "RUN_AUTOMATION",
    options,
  });
});
