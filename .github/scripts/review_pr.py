import os, requests, anthropic

# Get environment variables
api_key    = os.environ['ANTHROPIC_API_KEY']
gh_token   = os.environ['GITHUB_TOKEN']
pr_number  = os.environ['PR_NUMBER']
repo       = os.environ['REPO']

# Fetch the PR diff from GitHub
headers = {'Authorization': f'token {gh_token}', 'Accept': 'application/vnd.github.diff'}
diff_url = f'https://api.github.com/repos/{repo}/pulls/{pr_number}'
diff = requests.get(diff_url, headers=headers).text

# Send diff to Claude for review
client = anthropic.Anthropic(api_key=api_key)
message = client.messages.create(
    model='claude-opus-4-6',
    max_tokens=1024,
    messages=[{
        'role': 'user',
        'content': f'''Review this pull request diff. Check for:
        - Security issues or vulnerabilities
        - Missing error handling
        - Missing tests
        - Code quality issues
        Be concise and constructive.

        DIFF:
        {diff[:8000]}'''
    }]
)

review_text = message.content[0].text

# Post the review as a comment on the PR
comment_url = f'https://api.github.com/repos/{repo}/issues/{pr_number}/comments'
headers2 = {'Authorization': f'token {gh_token}', 'Content-Type': 'application/json'}
body = f'## 🤖 Claude AI Review\n\n{review_text}'
requests.post(comment_url, headers=headers2, json={'body': body})
print('Review posted successfully!')
