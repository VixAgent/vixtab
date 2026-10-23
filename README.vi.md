<p align="center"><img src="docs/images/icon.svg" width="96" alt="VixTab"></p>

<h1 align="center">VixTab</h1>

<p align="center"><b>Chạy nhiều phiên Claude Code song song trên cùng một repo: mỗi phiếu một tab VS Code mới có nhãn riêng,
gộp mã không xung đột, phiên điều phối giữ ngữ cảnh của chính nó luôn nhỏ.</b></p>

<p align="center"><a href="README.md">English</a> · Tiếng Việt</p>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/hero-dark.svg"><img src="docs/images/hero.svg" alt="Một tab điều phối, mỗi phiếu một tab mới ở cột riêng" width="100%"></picture>

## VixTab giải quyết việc gì

Một phiên Claude Code làm việc lâu sẽ chậm dần và tốn dần: mỗi lượt phải đọc lại toàn bộ ngữ cảnh ngày càng dài, tới lúc bị nén
thì mất chi tiết. Tự tay chia việc cho nhiều phiên thì mất công và dễ hỏng: hai phiên sửa cùng một tệp, đẩy đè lên nhau, bỏ quên
máy chủ dev, còn người dùng phải chép lời nhắn qua lại giữa các tab.

VixTab biến một tab Claude Code thành **phiên điều phối**. Phiên này chia mục tiêu thành các phiếu tự đủ, **mở cho mỗi phiếu một
tab mới** ở cột riêng, giao việc bằng một dòng, nằm chờ tới khi có sự kiện, rồi đóng tab khi phiếu xong. Mỗi phiếu làm trong
worktree git riêng và vào nhánh `main` qua hàng đợi gộp có chạy test.

## Chức năng

- **Điều phối tự động, tiết kiệm ngữ cảnh.** Phiên điều phối không tự làm phiếu. Mỗi phiếu chạy trên một phiên mới, ngữ cảnh nhỏ,
  xong thì đóng. Phiên điều phối chỉ đọc kết quả một dòng và chờ bằng tiến trình nền, nên không tốn token khi không có việc.
- **Mỗi phiếu một tab, một cột.** Nhãn tab là mã phiếu; tab mở ở cột mới bên phải, không giật focus, các cột được chia đều, đóng
  đúng tab theo nhãn. Mở tab không gọi model nên không tốn token và tab dùng model mặc định.
- **Song song không xung đột.** Khoá nguyên tử, mỗi phiếu một worktree và một nhánh, hàng đợi gộp tuần tự: rebase, ghi trạng thái
  **sau** rebase, chạy test, rồi mới đẩy. Test đỏ không bao giờ vào `main`.
- **Mặc định chạy song song, chỉ xếp hàng khi trùng thật.** Phiếu ghi rõ vùng mã. Trùng hàm thì chờ (`--after`); chỉ trùng tệp thì
  vẫn chạy song song, và `vixtab wait` báo phiếu đến sau rebase khi phiếu trước đã gộp.
- **Cổng tài nguyên thay cho trần số phiên.** Chỉ mở tab mới khi RAM trống (đã trừ phần dành cho các tab vừa mở trong 90 giây),
  swap, bộ nhớ cam kết (Windows) và CPU đều còn chỗ. Lượt nặng (trọn bộ test, E2E, dựng, trình duyệt) đi qua các ô co giãn có
  trần bộ nhớ: cgroup trên Linux, Job Object trên Windows.
- **Hỏi đáp gọn.** Phiên bị vướng hỏi bằng `vixtab ticket ask`; câu hỏi ghi vào phiếu trên `main`, phiên điều phối được đánh thức
  và trả lời một lần.
- **Dọn dẹp an toàn.** `done` từ chối đẩy mã chưa qua test, dừng tiến trình còn chạy trong worktree, gỡ worktree. Không bao giờ
  dừng VS Code, Claude Code, sshd hay vỏ hệ điều hành.
- **Chạy trên Linux và Windows.** Một mã nguồn chung, phần riêng của từng hệ điều hành nằm trong 2 tệp nhỏ. Phát hành dạng một
  chương trình chứa sẵn runtime: máy người dùng không cần Bun, Node hay Python.

## Cài đặt và bắt đầu

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/install-dark.svg"><img src="docs/images/install.svg" alt="Cài VixTab, bấm Set up, bấm VixTab trên thanh trạng thái rồi gõ mục tiêu" width="100%"></picture>

1. **Cài extension:** trong VS Code tìm **VixTab** (`phanthaitrung.vixtab`), hoặc tải tệp `.vsix` theo hệ điều hành ở trang
   [Releases](https://github.com/VixAgent/vixtab/releases). Extension Claude Code được cài kèm nếu máy chưa có.
2. **Bấm "Set up"** ở thông báo (hoặc *VixTab: Set up*): chép chương trình `vixtab` vào `~/.vixtab/bin`, thêm vào PATH, cài 2
   skill Claude Code `vixtab-orchestrate` và `vixtab-ticket` vào `~/.claude/skills`.
3. **Mở repo, bấm "VixTab"** ở thanh trạng thái: tab *Orchestrator* mở ra với `/vixtab-orchestrate` điền sẵn. Gõ mục tiêu rồi
   Enter.

Lần đầu, phiên điều phối đề nghị tạo bảng phiếu (`vixtab init --push`), và Claude Code hỏi một lần có tin cậy thư mục hay không.
VixTab không bao giờ tự trả lời câu hỏi đó thay bạn.

**Cần có:** VS Code 1.90 trở lên, extension Claude Code đã đăng nhập, git, một remote có nhánh `main` (repo trần cục bộ cũng
được). Linux x64/arm64 hoặc Windows 10/11 x64.

## Thử trên playground

`vixtab playground create` tạo sân thử ở `~/vixtab-playground`: một origin trần cục bộ, một dự án "sổ công thức" nhỏ và 5 phiếu
mẫu. Sân thử không chạm tới GitHub hay repo thật.

| Mức | Thấy gì | Tốn token |
|---|---|---|
| `vixtab playground demo board` | 4 phiếu nhận cùng lúc, nhận trùng bị từ chối, dò chồng chéo, hàng đợi gộp, test đỏ bị chặn, sự kiện `rebase` và `ask`, `done` dừng tiến trình sót, chiếm lại khoá bỏ rơi | không |
| `vixtab playground demo tabs` | 3 tab Claude có nhãn mở ở các cột bên phải, chia đều, rồi đóng | không |
| `vixtab playground demo heavy` | 5 lượt nặng chia nhau 2 ô; lượt vượt trần bộ nhớ bị dừng | không |
| Mở `~/vixtab-playground/project`, bấm **VixTab**, gõ *do all tickets on the board* | điều phối thật: mỗi phiếu một tab, làm, gộp, hỏi, xong, tab tự đóng | ít |

## Tài liệu chi tiết

Bảng lệnh, cấu hình `vixtab.config.json`, cách hoạt động, khác biệt Linux và Windows, giới hạn và bảo mật: xem
[README tiếng Anh](README.md) và [xử lý sự cố](docs/troubleshooting.md).

## Giấy phép

[MIT](LICENSE) © phanthaitrung. VixTab là dự án độc lập, không liên kết với Anthropic.
