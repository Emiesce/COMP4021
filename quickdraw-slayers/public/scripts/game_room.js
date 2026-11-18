const GameRoom = (function() {
    // This stores the signed in user
    let user = null;
    const hooks = { onSignIn: null, onSignOut: null };

    // Show a message under a form; errors are red, success messages are green
    const showMessage = function(selector, text, isError) {
        $(selector).text(text).toggleClass("error", !!text && isError).toggleClass("success", !!text && !isError);
    };

    // Returns an error message, or "" when the registration input is fine
    const validateRegister = function(username, avatar, name, password, confirmPassword) {
        if (!username || !avatar || !name || !password || !confirmPassword)
            return "Please fill in every field (username, avatar, name and password).";
        if (!/^\w+$/.test(username))
            return "Username can only contain letters, numbers and underscores.";
        if (password != confirmPassword)
            return "Passwords do not match.";
        return "";
    };

    const init = function() {
        // Populate the avatar selection
        Avatar.populate($("#register-avatar"));

        $("#start-signin-button").on("click", function() {
            // Show the signin page
            $("#game-room-start-page").hide();
            $("#game-room-signin-page").show();
            $("#signin-form").get(0).reset();
            showMessage("#signin-message", "", false);
        });

        $("#start-register-button").on("click", function() {
            // Show the register page
            $("#game-room-start-page").hide();
            $("#game-room-register-page").show();
            $("#register-form").get(0).reset();
            showMessage("#register-message", "", false);
        });

        $(".back-button").on("click", function() {
            // Show the start page
            $("#game-room-start-page").show();
            $("#game-room-signin-page").hide();
            $("#game-room-register-page").hide();
        });

        $("#register-button").on("click", function(e) {
            // Do not submit the form
            e.preventDefault();

            //
            // A. Preparing the user data
            //

            // Get the input fields
            const username = $("#register-username").val().trim();
            const avatar   = $("#register-avatar").val();
            const name     = $("#register-name").val().trim();
            const password = $("#register-password").val().trim();
            const confirmPassword = $("#register-confirm").val().trim();

            // Client-side validation (the server checks everything again)
            const problem = validateRegister(username, avatar, name, password, confirmPassword);
            if (problem) {
                showMessage("#register-message", problem, true);
                return;
            }
            
            // Create the JSON data
            const json = JSON.stringify({ username, avatar, name, password });

            //
            // B. Sending the AJAX request to the server
            //

            // Send a register request
            fetch("/register", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: json
            })
                .then((res) => res.json())
                .then((json) => {
                    console.log("Endpoint '/register' -", json); // FOR MARKING - DON'T DELETE

                    //
                    // F. Processing any error returned by the server
                    //
                    if (json.error) {
                        showMessage("#register-message", json.error, true);
                        return;
                    }

                    //
                    // J. Handling the success response from the server
                    //
                    $("#register-form").get(0).reset();
                    showMessage("#register-message", "Your account has been successfully registered. You can sign in now.", false);
                })
                .catch((err) => {
                    showMessage("#register-message", "Could not reach the server.", true);
                });
        });

        $("#signin-button").on("click", function(e) {
            // Do not submit the form
            e.preventDefault();

            // Get the input fields
            const username = $("#signin-username").val().trim();
            const password = $("#signin-password").val().trim();

            if (!username || !password) {
                showMessage("#signin-message", "Please enter your username and password.", true);
                return;
            }

            //
            // A. Preparing the user data
            //

            // Create the JSON data
            const json = JSON.stringify({ username, password });

            //
            // B. Sending the AJAX request to the server
            //
            
            // Send a signin request
            fetch("/signin", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: json
            })
                .then((res) => res.json())
                .then((json) => {
                    console.log("Endpoint '/signin' -", json); // FOR MARKING - DON'T DELETE

                    //
                    // F. Processing any error returned by the server
                    //
                    if (json.error) {
                        showMessage("#signin-message", json.error, true);
                        return;
                    }

                    //
                    // H. Handling the success response from the server
                    //

                    // Set the user information
                    user = json.user;
                    $("#game-room-user-avatar").html(Avatar.getCode(user.avatar));
                    $("#game-room-user-name").text(user.name);

                    // Show the content page
                    $("#game-room-signin-page").hide();
                    $("#game-room-content-page").show();
                    if (hooks.onSignIn) hooks.onSignIn(user);
                })
                .catch((err) => {
                    showMessage("#signin-message", "Could not reach the server.", true);
                });
        });

        // Click event for the signout button
        $("#signout-button").on("click", function(e) {
            // Do not submit the form
            e.preventDefault();

            // Send a signout request
            fetch("/signout")
                .then((res) => res.json())
                .then((json) => {
                    console.log("Endpoint '/signout' -", json); // FOR MARKING - DON'T DELETE

                    if (json.error) {
                        console.log(json.error);
                        return;
                    }

                    // Clear the user information
                    user = null;

                    // Show the start page
                    $("#game-room-content-page").hide();
                    $("#game-room-start-page").show();
                    if (hooks.onSignOut) hooks.onSignOut();
                })
                .catch((err) => {
                    console.log(err);
                });
        });
    }

    const validate = function() {
        // Send a validate request
        fetch("/validate")
            .then((res) => res.json())
            .then((json) => {
                console.log("Endpoint '/validate' -", json); // FOR MARKING - DON'T DELETE

                //
                // C. Processing any error returned by the server
                //

                if (json.error) {
                    console.log(json.error);
                    return;
                }

                //
                // E. Handling the success response from the server
                //

                // Set the user information
                user = json.user;
                $("#game-room-user-avatar").html(Avatar.getCode(user.avatar));
                $("#game-room-user-name").text(user.name);

                // Show the content page
                $("#game-room-start-page").hide();
                $("#game-room-content-page").show();
                if (hooks.onSignIn) hooks.onSignIn(user);
            })
            .catch((err) => {
                console.log(err);
            });
    }

    return { init, validate, hooks };
})();
